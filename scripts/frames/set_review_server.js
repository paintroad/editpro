// Local lifestyle-set review: one slide (room) at a time, the empty room beside its sample renders,
// approve / reject / spoken or typed notes, saved per slide to ~/.editpro/lifestyle-sets/set-review.json.
//   node scripts/frames/set_review_server.js   ->  http://localhost:3851
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.SET_REVIEW_PORT || 3851);
const ROOT = "C:\\Users\\divya\\Downloads\\_Frames\\_New Lifestyle Sets";
const FEEDBACK = path.join(os.homedir(), ".editpro", "lifestyle-sets", "set-review.json");
const PAGE = path.join(__dirname, "set-review.html");
const NEW_SET = /^(portrait|landscape|square|wide|tall)\s+(modern|kitchen|kids|motivational|statement)\s+(\d+)/i;
const SLIDE = /^(\d+)\.\s*(.+)\.(jpe?g|png|webp)$/i;
const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const ORDER = { modern: 0, statement: 1, kitchen: 2, kids: 3, motivational: 4 };
const SHAPE = { portrait: 0, landscape: 1, square: 2, wide: 3, tall: 4 };

function scan() {
  const out = [];
  for (const set of fs.readdirSync(ROOT)) {
    const m = set.match(NEW_SET);
    const dir = path.join(ROOT, set);
    if (!m || !fs.statSync(dir).isDirectory()) continue;
    const sampleDir = path.join(dir, "Samples");
    const samples = fs.existsSync(sampleDir) ? fs.readdirSync(sampleDir).filter((f) => !f.startsWith("_")) : [];
    for (const file of fs.readdirSync(dir)) {
      const s = file.match(SLIDE);
      if (!s || /^base\b/i.test(s[2])) continue;
      out.push({
        key: `${set}/${file}`,
        set,
        file,
        slide: Number(s[1]),
        room: s[2],
        group: m[2].toLowerCase(),
        shape: m[1].toLowerCase(),
        number: Number(m[3]),
        samples: samples.filter((f) => f.endsWith(` - ${file}`) || f.replace(/\.[^.]+$/, "").endsWith(` - ${file.replace(/\.[^.]+$/, "")}`)).sort(),
      });
    }
  }
  return out.sort((a, b) => ORDER[a.group] - ORDER[b.group] || SHAPE[a.shape] - SHAPE[b.shape] ||
    a.number - b.number || a.slide - b.slide);
}

const items = scan();
const byKey = new Map(items.map((item) => [item.key, item]));
let feedback = fs.existsSync(FEEDBACK) ? JSON.parse(fs.readFileSync(FEEDBACK, "utf8")) : {};

function save() {
  const tmp = `${FEEDBACK}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(feedback, null, 1));
  fs.renameSync(tmp, FEEDBACK);
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, fs.readFileSync(PAGE), "text/html");
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, { items, feedback });
    if (req.method === "GET" && url.pathname === "/img") {
      const item = byKey.get(url.searchParams.get("key") || "");
      if (!item) return send(res, 404, { error: "unknown slide" });
      const sample = url.searchParams.get("sample");
      if (sample && !item.samples.includes(sample)) return send(res, 404, { error: "unknown sample" });
      const file = sample ? path.join(ROOT, item.set, "Samples", sample) : path.join(ROOT, item.set, item.file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === "POST" && url.pathname === "/api/feedback") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { key, entry } = JSON.parse(body);
          if (!byKey.has(key)) return send(res, 400, { error: "unknown slide" });
          if (entry) feedback[key] = { ...entry, at: new Date().toISOString() };
          else delete feedback[key];
          save();
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 400, { error: error.message });
        }
      });
      return;
    }
    send(res, 404, { error: "not found" });
  })
  .listen(PORT, () => console.log(`Set review on http://localhost:${PORT} (${items.length} slides in ${new Set(items.map((i) => i.set)).size} sets)`));
