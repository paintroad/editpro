// One paid OpenAI image edit per painting, no retries. Input from regen_regions.py prep.
// node regen_regions.js <work_dir>
const fs = require("fs");
const path = require("path");
const { getOpenAiApiKey } = require("../../lib/config-store");
const { openAiImageBuffer } = require("../../lib/openai-image");

const MODEL = "gpt-image-2";

(async () => {
  const work = process.argv[2];
  const jobs = JSON.parse(fs.readFileSync(path.join(work, "jobs.json"), "utf8"));
  const key = getOpenAiApiKey();
  const log = path.join(work, "calls.jsonl");
  for (const [pid, job] of Object.entries(jobs)) {
    const out = path.join(work, `${pid}_out.png`);
    if (fs.existsSync(out)) {
      console.log(pid, "already done, not calling again");
      continue;
    }
    const tried = fs.existsSync(log) && fs.readFileSync(log, "utf8").includes(`"pid":"${pid}"`);
    if (tried) {
      console.log(pid, "already tried once, skipping");
      continue;
    }
    const image = await openAiImageBuffer(path.join(work, `${pid}_crop.png`), { quality: 95 });
    const form = new FormData();
    form.append("model", MODEL);
    form.append("image", new Blob([image], { type: "image/jpeg" }), `${pid}.jpg`);
    form.append("mask", new Blob([fs.readFileSync(path.join(work, `${pid}_mask.png`))], { type: "image/png" }), "mask.png");
    form.append("prompt", job.prompt);
    form.append("size", "1024x1024");
    form.append("quality", "high");
    form.append("n", "1");
    let status = "ok";
    try {
      const res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
      fs.writeFileSync(out, Buffer.from(data.data[0].b64_json, "base64"));
      console.log(pid, "done", data.usage ? JSON.stringify(data.usage) : "");
    } catch (e) {
      status = e.message;
      console.log(pid, "FAILED", e.message);
    }
    fs.appendFileSync(log, JSON.stringify({ pid, status, at: new Date().toISOString() }) + "\n");
  }
})();
