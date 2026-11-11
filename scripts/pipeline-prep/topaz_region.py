"""Upscale one region of an image with the Topaz API (one call), e.g. the area shared by several crops.

    py -3 topaz_region.py <src> <x0,y0,x1,y1 fractions> <out.jpg> [cgi|wonder|lowres]

Alpha is flattened onto white. Output targets 23.5 MP. Cgi (Art & CGI) costs 1 credit up to 24 MP.
"""
import math, sys, time, io
import requests
from PIL import Image
from prep_paths import topaz_key

Image.MAX_IMAGE_PIXELS = None
BASE = "https://api.topazlabs.com/image/v1"
MAX_MP = 23.5e6
NOFACE = {"face_enhancement": "false", "faceEnhancement": "false"}
MODELS = {
    "cgi": ("enhance", 8, {"model": "CGI", **NOFACE}),
    "lowres": ("enhance", 8, {"model": "Low Resolution V2", **NOFACE}),
    "wonder": ("enhance-gen", 6, {"model": "Wonder 3.5", "enhancement_strength": "high", "enhancementStrength": "high"}),
}


def main(src, box, out, model="cgi"):
    headers = {"X-API-KEY": topaz_key()}
    im = Image.open(src)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[3])
        im = bg
    im = im.convert("RGB")
    f = [float(v) for v in box.split(",")]
    px = (round(f[0] * im.width), round(f[1] * im.height), round(f[2] * im.width), round(f[3] * im.height))
    crop = im.crop(px)
    w, h = crop.size
    endpoint, max_scale, params = MODELS[model]
    s = min(max_scale, math.sqrt(MAX_MP / (w * h)))
    ow, oh = round(w * s), round(h * s)
    buf = io.BytesIO()
    crop.save(buf, "PNG")
    size = {"output_width": ow, "output_height": oh, "outputWidth": ow, "outputHeight": oh, "output_format": "jpeg"}
    r = requests.post(f"{BASE}/{endpoint}/async", headers=headers, files={"image": ("region.png", buf.getvalue())},
                      data={**params, **size}, timeout=300)
    if r.status_code >= 300:
        raise SystemExit(f"submit failed {r.status_code} {r.text[:300]}")
    pid = r.json()["process_id"]
    print("submitted", model, f"region {px} {w}x{h} -> {ow}x{oh}", flush=True)
    t0 = time.time()
    while True:
        st = requests.get(f"{BASE}/status/{pid}", headers=headers, timeout=60).json()
        if st.get("status") == "Completed":
            break
        if st.get("status") in ("Failed", "Cancelled"):
            raise SystemExit(f"topaz {st.get('status')}: {st}")
        time.sleep(5)
    url = requests.get(f"{BASE}/download/{pid}", headers=headers, timeout=60).json()["download_url"]
    open(out, "wb").write(requests.get(url, timeout=300).content)
    print("done", round(time.time() - t0), "s", Image.open(out).size, "credits", st.get("credits"), "region", px)


if __name__ == "__main__":
    main(*sys.argv[1:])
