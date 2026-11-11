// Local crop review: one painting at a time with its crop window, arrow keys to move the window,
// spoken or typed notes, saved per painting to ~/.editpro/pipeline-prep/crop-review.json.
//   node scripts/pipeline-prep/crop_review_server.js   ->  http://localhost:3850
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.CROP_REVIEW_PORT || 3850);
const PREP = path.join(os.homedir(), ".editpro", "pipeline-prep");
const ITEMS = path.join(PREP, "crop-review-items.json");
const FEEDBACK = path.join(PREP, "crop-review.json");
const ROOT = "C:\\Users\\divya\\Downloads\\_Existing Catalog Correction";
const PAGE = path.join(__dirname, "crop-review.html");
const TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const items = JSON.parse(fs.readFileSync(ITEMS, "utf8"));
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
      if (!item) return send(res, 404, { error: "unknown painting" });
      const clean = feedback[item.key]?.recipe?.clean;
      const file = clean && !url.searchParams.get("orig") && fs.existsSync(clean) ? clean : path.join(ROOT, item.folder, item.file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === "POST" && url.pathname === "/api/feedback") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { key, entry } = JSON.parse(body);
          if (!byKey.has(key)) return send(res, 400, { error: "unknown painting" });
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
  .listen(PORT, () => console.log(`Crop review on http://localhost:${PORT} (${items.length} paintings)`));
