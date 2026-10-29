"""Re-render only the black base image (image 1) of catalog products in place, after a base frame change.

    py -3 rerender_base_images.py <first product id> [<last product id>]

The previous file goes to <output folder>/_Archive/before-filled-base/<id>/. The file name stays the
same, so the store record and SEO names are unchanged; push the new file with replace_first_image.js.
"""
import json
import os
import shutil
import sys
from multiprocessing import Pool

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from lifestyle_compositor import composite_painting_into_frame  # noqa: E402

STORE = os.path.join(os.path.expanduser("~"), ".editpro", "catalog-products.json")
SETS = r"C:\Users\divya\Downloads\_Frame References\_New Lifestyle Sets"


def render(job):
    pid, painting, frame, template, orientation, frame_set, target = job
    archive = os.path.join(os.path.dirname(os.path.dirname(target)), "_Archive", "before-filled-base", pid)
    try:
        os.makedirs(archive, exist_ok=True)
        keep = os.path.join(archive, os.path.basename(target))
        if not os.path.exists(keep):
            shutil.copy2(target, keep)
        tmp = target + ".new.png"
        composite_painting_into_frame(
            painting, frame, tmp,
            orientation=orientation, frame_template=template, frame_set=frame_set, is_base=True,
        )
        os.replace(tmp, target)
        return pid, None
    except Exception as exc:  # noqa: BLE001
        return pid, str(exc)


def main(first, last):
    with open(STORE, encoding="utf-8") as fh:
        products = json.load(fh)["products"]
    jobs = []
    for pid, p in products.items():
        if not pid.isdigit() or not (first <= int(pid) <= last):
            continue
        base = next((i for i in p.get("lifestyleImages") or [] if i.get("index") == 1), None)
        painting = ((p.get("images") or [{}])[0]).get("path")
        frame_set = p.get("lifestyleSet")
        if not base or not painting or not frame_set:
            print(pid, "skipped: missing base image, painting or set")
            continue
        template = base["frameTemplate"]
        jobs.append((pid, painting, os.path.join(SETS, frame_set, template), template,
                     p.get("orientation"), frame_set, base["path"]))
    print(len(jobs), "base images to render")
    failed = 0
    with Pool(4) as pool:
        for n, (pid, error) in enumerate(pool.imap_unordered(render, jobs), 1):
            if error:
                failed += 1
                print(pid, "FAILED", error)
            if n % 50 == 0 or n == len(jobs):
                print(f"{n}/{len(jobs)} rendered, {failed} failed", flush=True)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    first = int(sys.argv[1])
    last = int(sys.argv[2]) if len(sys.argv) > 2 else first
    main(first, last)
