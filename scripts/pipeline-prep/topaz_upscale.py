"""Upscale Oriented paintings with the Topaz API straight into Upscaled.

    py -3 topaz_upscale.py wonder atrang_41 nakhrro_9 ...
    py -3 topaz_upscale.py lowres @names.txt
    py -3 topaz_upscale.py balance

Models: wonder (Wonder 3.5 high, generative, up to 6x, ~3 credits at 23.5 MP), cgi (Art & CGI),
lowres (Low Resolution V2), text (Text Refine). The precision models cost 1 credit up to 24 MP.
Output targets 23.5 MP. A painting already done with the same model is skipped; pass --redo to run
it again. The upscale being replaced is kept in ~/.editpro/pipeline-prep/replaced.
"""
import json, math, os, shutil, sqlite3, sys, time
import requests
from PIL import Image
from prep_paths import DB_PATH, PREP, folder, stems, topaz_key

Image.MAX_IMAGE_PIXELS = None
BASE = "https://api.topazlabs.com/image/v1"
MAX_MP = 23.5e6
NOFACE = {"face_enhancement": "false", "faceEnhancement": "false"}
# Both spellings are sent: generative jobs ignore output size when only camelCase is given.
MODELS = {
    "wonder": ("enhance-gen", 6, {"model": "Wonder 3.5", "enhancement_strength": "high", "enhancementStrength": "high"}),
    "cgi": ("enhance", 8, {"model": "CGI", **NOFACE}),
    "lowres": ("enhance", 8, {"model": "Low Resolution V2", **NOFACE}),
    "text": ("enhance", 8, {"model": "Text Refine", **NOFACE}),
}
STATE = os.path.join(PREP, "topaz_jobs.json")
WORK = os.path.join(PREP, "topaz_out")
REPLACED = os.path.join(PREP, "replaced")


def balance(headers):
    r = requests.get("https://api.topazlabs.com/account/v1/credits/balance", headers=headers, timeout=60)
    print(r.status_code, r.text[:200])


def main(args):
    headers = {"X-API-KEY": topaz_key()}
    if args[:1] == ["balance"]:
        return balance(headers)
    redo = "--redo" in args
    args = [a for a in args if a != "--redo"]
    if not args or args[0] not in MODELS:
        raise SystemExit(__doc__)
    key, names = args[0], args[1:]
    if len(names) == 1 and names[0].startswith("@"):
        names = open(names[0][1:], encoding="utf-8").read().split()
    endpoint, max_scale, params = MODELS[key]
    ori, ups = folder("Oriented"), folder("Upscaled")
    ori_files = stems(ori)
    os.makedirs(WORK, exist_ok=True)
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}

    def save():
        json.dump(state, open(STATE, "w"), indent=2)

    for name in names:
        prev = state.get(name)
        if prev and prev.get("model") == key and not redo and prev.get("file") not in (None, "FAILED", "WRONG SIZE"):
            continue
        if name not in ori_files:
            print(name, "not in Oriented")
            continue
        path = os.path.join(ori, ori_files[name])
        w, h = Image.open(path).size
        s = min(max_scale, math.sqrt(MAX_MP / (w * h)))
        ow, oh = int(w * s), int(h * s)
        size = {"output_width": ow, "output_height": oh, "outputWidth": ow, "outputHeight": oh, "output_format": "jpeg"}
        for attempt in range(6):
            with open(path, "rb") as fh:
                r = requests.post(f"{BASE}/{endpoint}/async", headers=headers, files={"image": fh},
                                  data={**params, **size}, timeout=300)
            if r.status_code != 429:
                break
            time.sleep(3 * 2 ** attempt)
        if r.status_code >= 300:
            print(name, "SUBMIT FAILED, stopping submissions:", r.status_code, r.text[:300], flush=True)
            break
        state[name] = {"model": key, "process_id": r.json()["process_id"], "out": [ow, oh], "submitted": time.time()}
        save()
        print(name, "submitted", key, f"{w}x{h} -> {ow}x{oh}", flush=True)

    pending = [k for k, v in state.items() if not v.get("file")]
    while pending:
        for k in list(pending):
            v = state[k]
            s = requests.get(f"{BASE}/status/{v['process_id']}", headers=headers, timeout=60).json()
            if s.get("status") == "Completed":
                url = requests.get(f"{BASE}/download/{v['process_id']}", headers=headers, timeout=60).json()["download_url"]
                tmp = os.path.join(WORK, f"{k}__{v['model']}.jpg")
                open(tmp, "wb").write(requests.get(url, timeout=300).content)
                got = list(Image.open(tmp).size)
                v.update(seconds=round(time.time() - v["submitted"]), credits=s.get("credits"), got=got)
                if all(abs(g - o) <= 2 for g, o in zip(got, v["out"])):
                    for f in os.listdir(ups):
                        if os.path.splitext(f)[0] == k:
                            os.makedirs(REPLACED, exist_ok=True)
                            shutil.move(os.path.join(ups, f), os.path.join(REPLACED, f"{k} - before {v['model']}{os.path.splitext(f)[1]}"))
                    v["file"] = os.path.join(ups, f"{k}.jpg")
                    shutil.move(tmp, v["file"])
                    with sqlite3.connect(DB_PATH) as db:  # same-name replacements keep stale sizes otherwise
                        db.execute("UPDATE images SET upscaled_width = NULL, upscaled_height = NULL WHERE name = ?", (k,))
                else:
                    v["file"] = "WRONG SIZE"
                save()
                pending.remove(k)
                print(k, "done", v["seconds"], "s", got, "credits", v["credits"],
                      "" if v["file"] != "WRONG SIZE" else f"WRONG SIZE, wanted {v['out']}", flush=True)
            elif s.get("status") in ("Failed", "Cancelled"):
                v.update(file="FAILED", status=s)
                save()
                pending.remove(k)
                print(k, s.get("status"), s, flush=True)
        if pending:
            time.sleep(5)
    done = [v for v in state.values() if v.get("file") not in (None, "FAILED", "WRONG SIZE")]
    print(f"done {len(done)}, credits {sum(v.get('credits') or 0 for v in done)}")
    print("Refresh Pipeline Prep in EditPro to record the new sizes.")


if __name__ == "__main__":
    main(sys.argv[1:])
