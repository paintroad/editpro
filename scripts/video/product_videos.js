#!/usr/bin/env node
/**
 * 30 product video concepts for one painting, rendered locally (FFmpeg + sharp, no paid calls).
 * Inputs: the high-res printable, the catalog room images, live product data from Shopify (read only),
 * the shared feature graphics and the brand logo.
 *
 *   node scripts/video/product_videos.js --number=11939 [--only=1,5,12] [--out="C:\Users\divya\Downloads\_Catalog\Product Videos"]
 *
 * Output: <out>/<number> <short title>/NN <concept> (<ratio>).mp4, plus thumbnails and a contact sheet.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const sharp = require("sharp");
const E = require("./video-engine");
const { getShopifyCredentials } = require("../../lib/config-store");
const { shopifyGraphql } = require("../../lib/shopify-client");
const { assertClean } = require("../../lib/brand-guard");

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const NUMBER = arg("number") || "11939";
const ONLY = arg("only") ? new Set(arg("only").split(",").map(Number)) : null;
const OUT_ROOT = arg("out") || path.join(os.homedir(), "Downloads", "_Catalog", "Product Videos");
const DL = path.join(os.homedir(), "Downloads");
const HOME = path.join(os.homedir(), ".editpro");

const INK = "#1A1A1A", GOLD = "#C9962B", RED = "#B3261E", MARIGOLD = "#F2A23A", CREAM = E.CREAM, SAFFRON = "#FFD58A";
const DEV = "Nirmala UI", SERIF = "Georgia", SANS = "Segoe UI";
const FMT = { V: [1080, 1920, "9x16"], S: [1080, 1080, "1x1"], L: [1920, 1080, "16x9"] };

const inr = (n) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const sizeLabel = (s) => s.replace(/"/g, "″").replace(/x/, "×");

function download(url, file) {
  if (fs.existsSync(file)) return Promise.resolve(file);
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`${url}: ${res.statusCode}`));
      const s = fs.createWriteStream(file);
      res.pipe(s);
      s.on("finish", () => s.close(() => resolve(file)));
    }).on("error", reject);
  });
}

function wrap(str, max) {
  const words = String(str).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

async function loadProduct(number) {
  const c = getShopifyCredentials();
  const d = await shopifyGraphql(c.storeDomain, c.accessToken, `query($q:String!){ productVariants(first:1, query:$q){ nodes { product {
    title handle onlineStoreUrl descriptionHtml variants(first:60){ nodes { price compareAtPrice selectedOptions{name value} } }
    media(first:30){ nodes { ... on MediaImage { image { url } } } } } } } }`, { q: `sku:${number}-*` });
  const p = d.productVariants.nodes[0]?.product;
  if (!p) throw new Error(`product ${number} not found`);
  const sizes = [];
  for (const v of p.variants.nodes) {
    const o = Object.fromEntries(v.selectedOptions.map((x) => [x.name, x.value]));
    let s = sizes.find((x) => x.size === o.Size);
    if (!s) sizes.push((s = { size: o.Size, code: o.Size.split(" - ")[0], dims: o.Size.split(" - ")[1], price: Number(v.price), compareAt: Number(v.compareAtPrice), material: o.Material, frames: [] }));
    if (!s.frames.includes(o.Frame)) s.frames.push(o.Frame);
  }
  const order = ["XS", "S", "M", "L", "XL"];
  sizes.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
  return {
    title: p.title, url: p.onlineStoreUrl,
    description: p.descriptionHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    sizes, features: p.media.nodes.map((m) => m.image?.url).filter((u) => /features-/.test(u || "")),
  };
}

// --- painting regions (fractions of the printable), Ram Darbar 11939 ---
const R = {
  full: { cx: 0.5, cy: 0.5, h: 1 },
  parasol: { cx: 0.47, cy: 0.1, h: 0.22 },
  rama: { cx: 0.48, cy: 0.33, h: 0.24 },
  sita: { cx: 0.61, cy: 0.42, h: 0.24 },
  hanuman: { cx: 0.14, cy: 0.45, h: 0.26 },
  brothersL: { cx: 0.27, cy: 0.33, h: 0.24 },
  brothersR: { cx: 0.8, cy: 0.33, h: 0.24 },
  lakshmana: { cx: 0.6, cy: 0.26, h: 0.2 },
  jewels: { cx: 0.48, cy: 0.45, h: 0.18 },
  sari: { cx: 0.6, cy: 0.62, h: 0.26 },
  throne: { cx: 0.48, cy: 0.84, h: 0.28 },
  caption: { cx: 0.27, cy: 0.955, h: 0.08 },
  upper: { cx: 0.5, cy: 0.32, h: 0.62 },
};

(async () => {
  const product = await loadProduct(NUMBER);
  const short = product.title.split(":")[0].trim();
  const dir = path.join(OUT_ROOT, `${NUMBER} ${short}`);
  const work = path.join(dir, "_work");
  fs.mkdirSync(work, { recursive: true });

  const assignments = JSON.parse(fs.readFileSync(path.join(HOME, "lifestyle-sets", "set-assignments.json"), "utf8")).paintings;
  const PRINT = path.join(DL, "_Catalog", "LIVE", "Printables", `${NUMBER}.jpg`);
  const roomDir = path.join(DL, "_Catalog", "Catalog Images", NUMBER);
  const roomFiles = fs.readdirSync(roomDir).filter((f) => /for-/.test(f));
  const room = (name) => path.join(roomDir, roomFiles.find((f) => f.includes(`for-${name}`)));
  const roomName = (f) => f.match(/for-(.+?)-\d+\.(jpg|png)$/)[1].replace(/-/g, " ");
  const rooms = roomFiles.filter((f) => !/haven/.test(f)).map((f) => ({ file: path.join(roomDir, f), name: roomName(f) }));
  const LOGO_BLACK = path.join(DL, "Brand Book", "Paintroad Brand Kit", "01 Logo", "paintroad-logo-black-transparent.png");
  const LOGO_WHITE = path.join(DL, "Brand Book", "Paintroad Brand Kit", "01 Logo", "paintroad-logo-white-transparent.png");
  const features = [];
  for (const u of product.features) features.push(await download(u, path.join(work, path.basename(u.split("?")[0]))));
  const related = ["13307", "13310", "13357"].filter((n) => assignments[n]?.image && fs.existsSync(assignments[n].image));
  const audio = E.makeAudio(work);
  const from = product.sizes[0];
  const M = product.sizes.find((s) => s.code === "M") || product.sizes[0];
  const logo64 = async (file, w) => "data:image/png;base64," + (await sharp(file).resize({ width: w }).png().toBuffer()).toString("base64");
  const img64 = async (file, w, h, fit = "cover", pos = "centre") => "data:image/jpeg;base64," + (await sharp(file).resize(w, h, { fit, position: pos }).jpeg({ quality: 90 }).toBuffer()).toString("base64");
  const logoB = await logo64(LOGO_BLACK, 360);
  const logoW = await logo64(LOGO_WHITE, 360);

  let li = 0;
  const L = async (fmt, body, opts) => E.layerPng(path.join(work, `layer-${++li}.png`), FMT[fmt][0], FMT[fmt][1], E.DEFS + body, opts);
  const still = async (fmt, body, name) => {
    const f = path.join(work, `${name || "still-" + ++li}.png`);
    await E.layerPng(f, FMT[fmt][0], FMT[fmt][1], E.DEFS + body, { background: CREAM });
    return f;
  };

  // --- shared pieces ---
  const endCards = {};
  async function endCard(fmt) {
    if (endCards[fmt]) return endCards[fmt];
    const [W, H] = FMT[fmt];
    const titleLines = wrap(short, fmt === "L" ? 28 : 18);
    const cy = H / 2;
    const lg = fmt === "L" ? 300 : 340;
    let body = `<image href="${logoB}" x="${W / 2 - lg / 2}" y="${cy - (fmt === "V" ? 520 : fmt === "S" ? 430 : 400)}" width="${lg}" height="${lg * 0.755}"/>`;
    let y = cy + (fmt === "V" ? -150 : -80);
    for (const t of titleLines) { body += E.text(W / 2, y, t, { size: fmt === "V" ? 76 : 64, font: SERIF, italic: true, color: INK, shadow: false }); y += fmt === "V" ? 92 : 78; }
    y += 40;
    body += E.text(W / 2, y, `From ${inr(from.price)}`, { size: fmt === "V" ? 64 : 56, font: SANS, weight: 700, color: INK, shadow: false });
    y += 70;
    body += E.text(W / 2, y, `${product.sizes.length} sizes · ${M.frames.length} frame styles · Free shipping`, { size: fmt === "V" ? 36 : 32, font: SANS, color: "#555", shadow: false });
    y += fmt === "V" ? 130 : 100;
    body += `<rect x="${W / 2 - 230}" y="${y - 58}" width="460" height="84" rx="42" fill="${INK}"/>` + E.text(W / 2, y - 3, "paintroad.com", { size: 40, font: SANS, weight: 700, color: CREAM, shadow: false });
    endCards[fmt] = await still(fmt, body, `endcard-${fmt}`);
    return endCards[fmt];
  }
  const endShot = async (fmt, dur = 3) => ({ src: await endCard(fmt), W: FMT[fmt][0], H: FMT[fmt][1], dur, from: { cx: 0.5, cy: 0.5, h: 1 }, to: { cx: 0.5, cy: 0.5, h: 0.95 } });
  const shot = (fmt, src, dur, fromV, toV, layers = [], extra = {}) => ({ src, W: FMT[fmt][0], H: FMT[fmt][1], dur, from: fromV, to: toV, layers, ...extra });

  // Caption band at the bottom (9:16 / 1:1) with optional Devanagari line.
  async function caption(fmt, main, sub, { dev = null, top = false } = {}) {
    const [W, H] = FMT[fmt];
    const band = top ? `<rect width="${W}" height="${H * 0.3}" fill="url(#fadeTop)"/>` : `<rect y="${H * 0.62}" width="${W}" height="${H * 0.38}" fill="url(#fadeBottom)"/>`;
    let y = top ? (fmt === "V" ? 210 : 130) : H - (fmt === "V" ? 250 : 170);
    let body = band;
    if (dev) { body += E.text(W / 2, y - (fmt === "V" ? 95 : 80), dev, { size: fmt === "V" ? 66 : 54, font: DEV, weight: 700, color: SAFFRON }); }
    body += E.text(W / 2, y, main, { size: fmt === "V" ? 70 : 58, font: SERIF, italic: true, color: "#fff" });
    if (sub) body += E.text(W / 2, y + (fmt === "V" ? 80 : 66), sub, { size: fmt === "V" ? 40 : 34, font: SANS, color: "#f1e7d6" });
    return L(fmt, body);
  }

  async function framedPng(file, { pw, frame, src = PRINT, shadow = true }) {
    const meta = await sharp(src).metadata();
    const ph = Math.round((pw * meta.height) / meta.width);
    const fw = frame === "Stretched Canvas" ? 0 : Math.round(pw * 0.045);
    const pad = shadow ? Math.round(pw * 0.12) : 0;
    const W = pw + 2 * fw + 2 * pad, H = ph + 2 * fw + 2 * pad;
    const art = await img64(src, pw, ph, "fill");
    const styles = {
      Black: `<rect x="${pad}" y="${pad}" width="${pw + 2 * fw}" height="${ph + 2 * fw}" fill="#141414"/><rect x="${pad + 3}" y="${pad + 3}" width="${pw + 2 * fw - 6}" height="${ph + 2 * fw - 6}" fill="none" stroke="#3a3a3a" stroke-width="2"/>`,
      White: `<rect x="${pad}" y="${pad}" width="${pw + 2 * fw}" height="${ph + 2 * fw}" fill="#F4F2EE"/><rect x="${pad + 1}" y="${pad + 1}" width="${pw + 2 * fw - 2}" height="${ph + 2 * fw - 2}" fill="none" stroke="#d9d4cb" stroke-width="2"/>`,
      Wooden: `<linearGradient id="wd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#B98350"/><stop offset="0.5" stop-color="#9A6534"/><stop offset="1" stop-color="#B27C47"/></linearGradient><rect x="${pad}" y="${pad}" width="${pw + 2 * fw}" height="${ph + 2 * fw}" fill="url(#wd)"/>`,
      "Dark Brown": `<linearGradient id="db" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4E2F1E"/><stop offset="1" stop-color="#2E1A10"/></linearGradient><rect x="${pad}" y="${pad}" width="${pw + 2 * fw}" height="${ph + 2 * fw}" fill="url(#db)"/>`,
      "Stretched Canvas": ``,
    };
    const sh = shadow ? `<filter id="ds" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${pw * 0.025}"/></filter><rect x="${pad + pw * 0.02}" y="${pad + pw * 0.035}" width="${pw + 2 * fw}" height="${ph + 2 * fw}" fill="#000" fill-opacity="0.38" filter="url(#ds)"/>` : "";
    const inner = fw ? `<rect x="${pad + fw - 2}" y="${pad + fw - 2}" width="${pw + 4}" height="${ph + 4}" fill="#000" fill-opacity="0.25"/>` : "";
    const edge = frame === "Stretched Canvas" ? `<rect x="${pad + pw - 6}" y="${pad}" width="6" height="${ph}" fill="#000" fill-opacity="0.18"/><rect x="${pad}" y="${pad + ph - 6}" width="${pw}" height="6" fill="#000" fill-opacity="0.22"/>` : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${sh}${frame in styles ? styles[frame] : styles.Black}${inner}<image href="${art}" x="${pad + fw}" y="${pad + fw}" width="${pw}" height="${ph}" preserveAspectRatio="none"/>${edge}</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(file);
    return { file, W, H };
  }

  async function palette(src, k = 6) {
    const { data } = await sharp(src).resize(80, 80, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = [];
    for (let i = 0; i < data.length; i += 3) px.push([data[i], data[i + 1], data[i + 2]]);
    let cents = Array.from({ length: k }, (_, i) => px[Math.floor((i * px.length) / k)]);
    let counts = [];
    for (let it = 0; it < 12; it++) {
      const sums = cents.map(() => [0, 0, 0, 0]);
      for (const p of px) {
        let best = 0, bd = Infinity;
        cents.forEach((c, j) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; best = j; } });
        const s = sums[best]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
      }
      cents = sums.map((s, j) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cents[j]));
      counts = sums.map((s) => s[3]);
    }
    const sat = (c) => { const mx = Math.max(...c), mn = Math.min(...c); return mx ? (mx - mn) / mx : 0; };
    const ranked = cents.map((c, j) => ({ c, n: counts[j], vivid: sat(c) > 0.4 && counts[j] >= px.length * 0.015 })).sort((a, b) => b.n - a.n);
    const order = [...ranked.filter((o) => o.vivid), ...ranked.filter((o) => !o.vivid)].map((o) => o.c);
    const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const NAMES = [["Temple red", [178, 52, 40]], ["Royal blue", [70, 110, 170]], ["Krishna blue", [90, 140, 190]], ["Leaf green", [40, 120, 70]], ["Marigold", [230, 160, 50]], ["Turmeric", [220, 180, 70]], ["Earth brown", [110, 80, 60]], ["Sandalwood", [200, 170, 130]], ["Ivory", [235, 225, 205]], ["Saffron", [230, 120, 50]], ["Lotus pink", [220, 130, 130]], ["Terracotta", [200, 120, 80]], ["Kesar", [225, 150, 95]], ["Ash grey", [140, 135, 125]]];
    const name = (c) => NAMES.reduce((b, [n, v]) => { const d = (c[0] - v[0]) ** 2 + (c[1] - v[1]) ** 2 + (c[2] - v[2]) ** 2; return d < b.d ? { n, d } : b; }, { n: "", d: Infinity }).n;
    const used = new Set();
    return order.map((c) => ({ hex: hex(c), name: name(c) })).filter((c) => !used.has(c.name) && used.add(c.name));
  }

  // --- the 30 concepts ---
  const C = [];
  const add = (id, title, fmt, pitch, build) => C.push({ id, title, fmt, pitch, build });

  add(1, "Slow Darshan", "V", "A slow, reverent push from the full painting to Lord Rama's face, with the name in Devanagari and English. Calm drone and temple bell.", async () => ({
    shots: [
      shot("V", PRINT, 9, R.full, R.rama, [{ png: await caption("V", short, "Vintage devotional print", { dev: "श्री राम दरबार" }), start: 2, fade: 1, rise: 30 }]),
      await endShot("V"),
    ], audio: audio.droneBell,
  }));

  add(2, "Details You'd Miss", "V", "Four close-ups the eye skips on a phone screen: the royal parasol, Sita's sari border, Hanuman in devotion, the lotus throne. Then the full reveal.", async () => {
    const beats = [[R.parasol, "The royal chhatra"], [R.sari, "Sita's green sari, gold border"], [R.hanuman, "Hanuman, bowed in devotion"], [R.throne, "The lotus throne"]];
    const shots = [];
    for (const [v, t] of beats) shots.push(shot("V", PRINT, 2.6, { ...v, h: v.h * 1.15 }, v, [{ png: await caption("V", t, null, { top: true }), start: 0.3, fade: 0.5 }]));
    shots.push(shot("V", PRINT, 3, { ...R.full, h: 0.8 }, R.full, [{ png: await caption("V", "All of it, on your wall", short), start: 0.4 }]));
    shots.push(await endShot("V"));
    return { shots, audio: audio.drone };
  });

  add(3, "Scroll Unveil", "V", "The painting unrolls top to bottom like a temple scroll, parasol to throne to the original Devanagari caption.", async () => ({
    shots: [
      shot("V", PRINT, 8, { cx: 0.5, cy: 0.12, h: 0.45 }, { cx: 0.5, cy: 0.88, h: 0.45 }, [{ png: await caption("V", "Unveil the Darbar", null, { top: true, dev: "श्री रामपंचायतन" }), start: 0.5, end: 4, fade: 0.6 }], { ease: "linear" }),
      shot("V", PRINT, 2.5, { ...R.full, h: 0.9 }, R.full),
      await endShot("V"),
    ], audio: audio.drone,
  }));

  add(4, "Diya Light", "V", "Starts in near darkness; warm, flickering lamp light slowly reveals the Darbar. Made for evening aarti moods and Diwali.", async () => {
    const [W, H] = FMT.V;
    const glow = await L("V", `<radialGradient id="g" cx="0.5" cy="0.92" r="0.6"><stop offset="0" stop-color="#FFB547" stop-opacity="0.55"/><stop offset="1" stop-color="#FFB547" stop-opacity="0"/></radialGradient><rect width="${W}" height="${H}" fill="url(#g)"/>`);
    return {
      shots: [
        shot("V", PRINT, 8, { cx: 0.5, cy: 0.42, h: 0.75 }, { cx: 0.5, cy: 0.38, h: 0.6 }, [
          { png: glow, start: 0, end: 7, fade: 2 },
          { png: await caption("V", "Light a diya.", "Invite the Darbar home.", { dev: "शुभ दीपावली" }), start: 4, fade: 0.8, rise: 30 },
        ], { post: `eq=brightness='-0.42+0.42*min(1\\,max(0\\,(t-0.8)/4.5))+0.025*sin(t*21)*sin(t*7.3)':saturation='0.6+0.4*min(1\\,t/5)':eval=frame` }),
        await endShot("V"),
      ], audio: audio.droneBell,
    };
  });

  add(5, "Meet the Darbar", "V", "A guided tour that names each figure: Rama, Sita, Hanuman, then Lakshmana, Bharata and Shatrughna. Educational and shareable.", async () => {
    const beats = [[R.rama, "Lord Rama", "श्री राम"], [R.sita, "Mata Sita", "सीता माता"], [R.hanuman, "Hanuman", "हनुमान"], [R.brothersL, "Lakshmana, Bharata", "& Shatrughna in attendance"]];
    const shots = [];
    for (const [v, a, b] of beats) {
      const devanagari = /[\u0900-\u097F]/.test(b);
      shots.push(shot("V", PRINT, 2.6, { ...v, h: v.h * 1.12 }, v, [{ png: await caption("V", a, devanagari ? null : b, { dev: devanagari ? b : null }), start: 0.3, fade: 0.5, rise: 24 }]));
    }
    shots.push(shot("V", PRINT, 2.8, R.lakshmana, R.full, [{ png: await caption("V", "Ram Panchayatan", "The whole divine court") , start: 1, fade: 0.6 }]));
    shots.push(await endShot("V"));
    return { shots, audio: audio.drone };
  });

  add(6, "Zoom Test", "V", "Proof of print quality: keeps zooming into the jewellery and faces and stays crisp. Answers 'will it look pixelated at 36×48?'", async () => ({
    shots: [
      shot("V", PRINT, 2.4, R.full, R.full, [{ png: await caption("V", "Zoom in.", null, { top: true }), start: 0.3 }]),
      shot("V", PRINT, 3.2, R.full, R.jewels, [{ png: await caption("V", "Closer.", null, { top: true }), start: 0.3 }]),
      shot("V", PRINT, 3.2, R.jewels, { ...R.jewels, h: 0.08 }, [{ png: await caption("V", "Still sharp.", "Printed from a high-resolution master", { top: true }), start: 0.3 }]),
      shot("V", PRINT, 2.2, { ...R.jewels, h: 0.08 }, R.full, [], { ease: "smooth" }),
      await endShot("V"),
    ], audio: audio.drone, transitionType: ["fade", "fade", "fade", "fade"],
  }));

  add(7, "Colour Story", "S", "The painting's palette pulled out as swatches with names (Temple red, Royal blue, Leaf green). Helps buyers match decor.", async () => {
    const pal = (await palette(PRINT, 12)).slice(0, 5);
    const art = await img64(PRINT, 560, 746, "fill");
    const base = await still("S", `<image href="${art}" x="70" y="167" width="560" height="746"/>` + E.text(860, 150, "Colour story", { size: 52, font: SERIF, italic: true, color: INK, shadow: false }));
    const layers = [];
    for (let i = 0; i < pal.length; i++) {
      const y = 220 + i * 150;
      layers.push({ png: await L("S", `<rect x="700" y="${y}" width="110" height="110" rx="14" fill="${pal[i].hex}"/>` + E.text(830, y + 50, pal[i].name, { size: 36, font: SANS, weight: 700, color: INK, anchor: "start", shadow: false }) + E.text(830, y + 92, pal[i].hex.toUpperCase(), { size: 26, font: SANS, color: "#777", anchor: "start", shadow: false })), start: 0.8 + i * 0.9, fade: 0.5, rise: 20 });
    }
    return { shots: [shot("S", base, 7.5, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.5, h: 0.97 }, layers), await endShot("S")], audio: audio.drone };
  });

  add(8, "The Coronation Story", "V", "The Ramayana moment in three lines over slow pans: exile ends, Ayodhya crowns its king, bring the blessing home.", async () => ({
    shots: [
      shot("V", PRINT, 4, R.parasol, { ...R.parasol, cy: 0.18, h: 0.3 }, [{ png: await caption("V", "Fourteen years of exile end.", null), start: 0.4, fade: 0.6 }]),
      shot("V", PRINT, 4, { ...R.rama, h: 0.3 }, R.sita, [{ png: await caption("V", "Ayodhya crowns its king.", "Rama and Sita take the throne"), start: 0.4, fade: 0.6 }]),
      shot("V", PRINT, 4, { ...R.full, h: 0.75 }, R.full, [{ png: await caption("V", "Bring that blessing home.", null, { dev: "राम राज्य" }), start: 0.4, fade: 0.6 }]),
      await endShot("V"),
    ], audio: audio.drone, transition: 0.8,
  }));

  add(9, "Ram Navami Greeting", "V", "A shareable festive card in our devotional arch style. Works as a WhatsApp forward with the product link.", async () => {
    const [W, H] = FMT.V;
    const art = await img64(PRINT, 820, 1093, "cover", "north");
    const garland = Array.from({ length: 18 }, (_, i) => `<circle cx="${30 + i * 60}" cy="${40 + 18 * Math.sin(i * 0.9)}" r="22" fill="${i % 2 ? MARIGOLD : "#F7F3E8"}"/>`).join("");
    const base = await still("V", `${garland}<clipPath id="arch"><path d="M130 1400 V560 A410 410 0 0 1 950 560 V1400 Z"/></clipPath><image href="${art}" x="130" y="150" width="820" height="1250" preserveAspectRatio="xMidYMin slice" clip-path="url(#arch)"/><path d="M130 1400 V560 A410 410 0 0 1 950 560 V1400" fill="none" stroke="${GOLD}" stroke-width="10"/>`);
    const text1 = await L("V", E.text(W / 2, 1530, "राम नवमी की शुभकामनाएँ", { size: 64, font: DEV, weight: 700, color: RED, shadow: false }) + E.text(W / 2, 1625, "Happy Ram Navami", { size: 72, font: SERIF, italic: true, color: INK, shadow: false }));
    const text2 = await L("V", E.text(W / 2, 1720, "May Shri Ram bless your home", { size: 38, font: SANS, color: "#555", shadow: false }));
    return { shots: [shot("V", base, 7, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.45, h: 0.93 }, [{ png: text1, start: 0.8, fade: 0.8, rise: 30 }, { png: text2, start: 2, fade: 0.8 }]), await endShot("V")], audio: audio.droneBell };
  });

  add(10, "Festival Banner (YouTube)", "L", "A 16:9 festive banner (Diwali, Dussehra, Ram Navami) with the painting panning behind a greeting. For YouTube and Demand Gen.", async () => {
    const [W, H] = FMT.L;
    const panel = await L("L", `<linearGradient id="lp" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.75"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient><rect width="${W * 0.6}" height="${H}" fill="url(#lp)"/>` +
      E.text(110, 430, "शुभ दीपावली", { size: 84, font: DEV, weight: 700, color: SAFFRON, anchor: "start" }) + E.text(110, 540, "The Darbar, home for the festival", { size: 56, font: SERIF, italic: true, anchor: "start" }) + E.text(110, 620, `${short} · from ${inr(from.price)}`, { size: 36, font: SANS, color: "#f1e7d6", anchor: "start" }));
    return { shots: [shot("L", PRINT, 9, { cx: 0.55, cy: 0.18, h: 0.4 }, { cx: 0.55, cy: 0.62, h: 0.4 }, [{ png: panel, start: 0.8, fade: 0.8 }], { ease: "linear" }), await endShot("L")], audio: audio.droneBell };
  });

  add(11, "Room Tour", "S", "The same painting in every room we render it for: pooja room, entrance, living room, dining, study. Answers 'where would it go?'", async () => {
    const shots = [];
    for (const r of rooms) shots.push(shot("S", r.file, 2.4, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.42, h: 0.85 }, [{ png: await caption("S", r.name.replace(/\b\w/g, (c) => c.toUpperCase()), null), start: 0.3, fade: 0.4 }]));
    shots.push(await endShot("S"));
    return { shots, audio: audio.drone, transition: 0.5 };
  });

  add(12, "Which Room? Poll", "S", "Four rooms in a grid with numbers and 'Comment 1, 2, 3 or 4'. Built for comments and saves on Reels and Shorts.", async () => {
    const pick = rooms.slice(0, 4);
    const tiles = [];
    for (const [i, r] of pick.entries()) tiles.push(`<image href="${await img64(r.file, 536, 536)}" x="${(i % 2) * 544}" y="${Math.floor(i / 2) * 544}" width="536" height="536"/>`);
    const base = await still("S", tiles.join(""));
    const nums = await L("S", pick.map((_, i) => `<circle cx="${(i % 2) * 544 + 60}" cy="${Math.floor(i / 2) * 544 + 60}" r="38" fill="${CREAM}"/>` + E.text((i % 2) * 544 + 60, Math.floor(i / 2) * 544 + 76, String(i + 1), { size: 44, font: SANS, weight: 700, color: INK, shadow: false })).join(""));
    const head = await L("S", `<rect x="190" y="470" width="700" height="140" rx="70" fill="${INK}" fill-opacity="0.85"/>` + E.text(540, 535, "Where would you hang it?", { size: 44, font: SERIF, italic: true, color: "#fff", shadow: false }) + E.text(540, 585, "Comment 1, 2, 3 or 4", { size: 32, font: SANS, color: SAFFRON, shadow: false }));
    const layers = [{ png: nums, start: 0.3 }, { png: head, start: 1, fade: 0.5, rise: 20 }];
    for (let i = 0; i < 4; i++) layers.push({ png: await L("S", `<rect x="${(i % 2) * 544 + 6}" y="${Math.floor(i / 2) * 544 + 6}" width="524" height="524" fill="none" stroke="${MARIGOLD}" stroke-width="12"/>`), start: 3 + i * 1.1, end: 3 + i * 1.1 + 1.1, fade: 0.25 });
    return { shots: [shot("S", base, 8, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.5, h: 0.96 }, layers), await endShot("S")], audio: audio.drone };
  });

  add(13, "Pooja Room Hero", "S", "One slow push into the pooja room render with a blessing line. The most 'product in use' shot, which Google asks for.", async () => ({
    shots: [shot("S", room("pooja-room"), 9, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.45, h: 0.62 }, [{ png: await caption("S", "The heart of your mandir", null, { dev: "जय श्री राम" }), start: 3, fade: 0.8, rise: 24 }]), await endShot("S")],
    audio: audio.droneBell,
  }));

  add(14, "Room to Detail Dive", "S", "Starts wide in the pooja room, dives into the frame and dissolves into the real print detail. Shows scale and quality in one move.", async () => ({
    shots: [
      shot("S", room("pooja-room"), 4, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.504, cy: 0.448, h: 0.4 }),
      shot("S", PRINT, 5, { cx: 0.5, cy: 0.47, h: 0.75 }, { cx: 0.53, cy: 0.37, h: 0.26 }, [{ png: await caption("S", "Every detail, true to the original", null), start: 1.2, fade: 0.6 }]),
      await endShot("S"),
    ], audio: audio.drone, transition: 0.9,
  }));

  add(15, "Griha Pravesh Gift", "S", "Gifting angle: 'A blessing for their new home', entrance and living room shots, ends with gift-ready packaging.", async () => ({
    shots: [
      shot("S", room("entrance"), 3.2, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.42, h: 0.8 }, [{ png: await caption("S", "Moving in?", null, { top: true }), start: 0.4 }]),
      shot("S", room("living-room"), 3.2, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.46, cy: 0.33, h: 0.7 }, [{ png: await caption("S", "Gift a blessing for their new home", null, { dev: "गृह प्रवेश" }), start: 0.4 }]),
      ...(features.find((f) => /packaging/.test(f)) ? [shot("S", features.find((f) => /packaging/.test(f)), 3, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.5, h: 0.97 })] : []),
      await endShot("S"),
    ], audio: audio.drone,
  }));

  add(16, "Where to Hang It (Vastu tip)", "S", "A short tip format: traditional guidance on placement (pooja room, east or north wall, eye level). Useful content that sells softly.", async () => ({
    shots: [
      shot("S", room("pooja-room"), 3.4, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.47, h: 0.8 }, [{ png: await caption("S", "Where should a Ram Darbar go?", "A traditional tip", { top: true }), start: 0.3 }]),
      shot("S", room("pooja-room"), 3.4, { cx: 0.5, cy: 0.47, h: 0.8 }, { cx: 0.5, cy: 0.45, h: 0.55 }, [{ png: await caption("S", "In the pooja room,", "on an east or north wall"), start: 0.3 }]),
      shot("S", room("entrance"), 3.4, { cx: 0.5, cy: 0.5, h: 0.95 }, { cx: 0.5, cy: 0.42, h: 0.7 }, [{ png: await caption("S", "Or facing the entrance,", "at eye level, to greet every guest"), start: 0.3 }]),
      await endShot("S"),
    ], audio: audio.drone,
  }));

  add(17, "Choose Your Size", "S", "The painting grows above a sofa from XS to XL with size and price, so buyers see real scale. Our most common pre-purchase question.", async () => {
    const [W, H] = FMT.S;
    const ppi = 9, floor = 1010, sofaTop = floor - 34 * ppi;
    const sx = W / 2 - 42 * ppi, sw = 84 * ppi;
    const sofa = `<rect y="${floor}" width="${W}" height="${H - floor}" fill="#C9B79C"/><rect y="${floor}" width="${W}" height="6" fill="#B9A688"/>` +
      [sx + 40, sx + sw - 58].map((x) => `<rect x="${x}" y="${floor - 30}" width="18" height="30" fill="#5A4030"/>`).join("") +
      `<rect x="${sx + 40}" y="${sofaTop}" width="${sw - 80}" height="170" rx="30" fill="#3E5B5A"/>` +
      `<rect x="${sx}" y="${floor - 160}" width="${sw}" height="130" rx="18" fill="#34504F"/>` +
      [0, 1, 2].map((i) => `<rect x="${sx + 74 + i * ((sw - 148) / 3)}" y="${floor - 185}" width="${(sw - 148) / 3 - 8}" height="62" rx="16" fill="#4D6E6C"/>`).join("") +
      [sx, sx + sw - 74].map((x) => `<rect x="${x}" y="${floor - 236}" width="74" height="206" rx="30" fill="#36524F"/>`).join("");
    const shots = [];
    for (const s of product.sizes) {
      const [iw, ih] = s.dims.replace(/"/g, "").split("x").map(Number);
      const pw = iw * ppi, ph = ih * ppi;
      const fr = await framedPng(path.join(work, `size-${s.code}.png`), { pw, frame: s.material === "Canvas" ? "Wooden" : "Black", shadow: true });
      const fb64 = "data:image/png;base64," + fs.readFileSync(fr.file).toString("base64");
      const x = W / 2 - fr.W / 2, yb = sofaTop - 8 * ppi;
      const base = await still("S", `<linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F3EBDD"/><stop offset="1" stop-color="#E6D9C3"/></linearGradient><rect width="${W}" height="${floor}" fill="url(#wall)"/>${sofa}<image href="${fb64}" x="${x}" y="${yb - fr.H + (fr.H - ph) / 2}" width="${fr.W}" height="${fr.H}"/>`);
      const label = await L("S", `<rect x="${W / 2 - 300}" y="40" width="600" height="120" rx="60" fill="${INK}" fill-opacity="0.88"/>` + E.text(W / 2, 98, `${s.code} · ${sizeLabel(s.dims)}`, { size: 44, font: SANS, weight: 700, color: "#fff", shadow: false }) + E.text(W / 2, 142, `${inr(s.price)} · ${s.material}`, { size: 32, font: SANS, color: SAFFRON, shadow: false }));
      shots.push(shot("S", base, 2.2, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.5, h: 0.98 }, [{ png: label, start: 0, fade: 0.3 }]));
    }
    shots.push(await endShot("S"));
    return { shots, audio: audio.drone, transition: 0.45 };
  });

  add(18, "Choose Your Frame", "S", "The same print cycles through Black, White, Wooden, Dark Brown and Stretched Canvas on a wall. Removes frame-choice hesitation.", async () => {
    const [W, H] = FMT.S;
    const shots = [];
    for (const f of M.frames) {
      const fr = await framedPng(path.join(work, `frame-${f.replace(/\s/g, "")}.png`), { pw: 560, frame: f });
      const fb64 = "data:image/png;base64," + fs.readFileSync(fr.file).toString("base64");
      const base = await still("S", `<linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F3EBDD"/><stop offset="1" stop-color="#E3D5BE"/></linearGradient><rect width="${W}" height="${H}" fill="url(#wall)"/><image href="${fb64}" x="${W / 2 - fr.W / 2}" y="${H / 2 - fr.H / 2 - 40}" width="${fr.W}" height="${fr.H}"/>`);
      const label = await L("S", E.text(W / 2, H - 70, f, { size: 52, font: SERIF, italic: true, color: INK, shadow: false }));
      shots.push(shot("S", base, 2, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.48, h: 0.96 }, [{ png: label }]));
    }
    shots.push(await endShot("S"));
    return { shots, audio: audio.drone, transition: 0.4 };
  });

  add(19, "Paper or Canvas?", "V", "Split screen: Fine Art Paper for small sizes, textured Canvas for M to XL, each with a close-up. Explains the material switch on our size picker.", async () => {
    const [W, H] = FMT.V;
    const paperCrop = await img64(PRINT, W, 900, "cover", "north");
    const meta = await sharp(PRINT).metadata();
    const canvasBuf = await sharp(PRINT).extract({ left: Math.round(meta.width * 0.42), top: Math.round(meta.height * 0.5), width: Math.round(meta.width * 0.42), height: Math.round(meta.width * 0.42 * 900 / W) }).resize(W, 900).jpeg().toBuffer();
    const weave = `<pattern id="wv" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 3H6M3 0V6" stroke="#000" stroke-opacity="0.16" stroke-width="1.4"/></pattern>`;
    const base = await still("V", `${weave}<image href="${paperCrop}" x="0" y="0" width="${W}" height="900"/><rect y="900" width="${W}" height="120" fill="${CREAM}"/><image href="data:image/jpeg;base64,${canvasBuf.toString("base64")}" x="0" y="1020" width="${W}" height="900"/><rect x="0" y="1020" width="${W}" height="900" fill="url(#wv)"/>` +
      E.text(W / 2, 980, "Paper or canvas?", { size: 56, font: SERIF, italic: true, color: INK, shadow: false }));
    const top = await L("V", `<rect x="40" y="740" width="620" height="120" rx="24" fill="${INK}" fill-opacity="0.85"/>` + E.text(70, 795, "Fine Art Paper", { size: 44, font: SANS, weight: 700, color: "#fff", anchor: "start", shadow: false }) + E.text(70, 840, `XS & S · smooth, matte, crisp`, { size: 30, font: SANS, color: SAFFRON, anchor: "start", shadow: false }));
    const bot = await L("V", `<rect x="40" y="1760" width="620" height="120" rx="24" fill="${INK}" fill-opacity="0.85"/>` + E.text(70, 1815, "Premium 320 GSM Canvas", { size: 44, font: SANS, weight: 700, color: "#fff", anchor: "start", shadow: false }) + E.text(70, 1860, `M, L & XL · woven texture, painterly`, { size: 30, font: SANS, color: SAFFRON, anchor: "start", shadow: false }));
    return { shots: [shot("V", base, 7, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.5, h: 0.95 }, [{ png: top, start: 0.6, fade: 0.5, rise: 20 }, { png: bot, start: 2.2, fade: 0.5, rise: 20 }]), await endShot("V")], audio: audio.drone };
  });

  add(20, "Why Paintroad", "S", "Our four feature graphics (material, frame sizes, frame build, packaging) as a quick trust montage before the end card.", async () => {
    const shots = [];
    for (const f of features) shots.push(shot("S", f, 2.6, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.5, h: 0.97 }));
    shots.unshift(shot("S", room("pooja-room"), 2.6, { cx: 0.5, cy: 0.5, h: 0.9 }, { cx: 0.5, cy: 0.45, h: 0.7 }, [{ png: await caption("S", "Why it's made to last", null, { top: true }), start: 0.3 }]));
    shots.push(await endShot("S"));
    return { shots, audio: audio.drone, transition: 0.5 };
  });

  add(21, "Price Reveal", "V", `Price-led ad: MRP struck through, the live price lands (${inr(M.compareAt)} to ${inr(M.price)} for M canvas). Uses live Shopify prices so it never goes stale.`, async () => {
    const [W, H] = FMT.V;
    const off = Math.round((1 - M.price / M.compareAt) * 100);
    const mrp = await L("V", E.text(W / 2, 1380, `MRP ${inr(M.compareAt)}`, { size: 64, font: SANS, color: "#ddd" }));
    const strike = await L("V", `<rect x="${W / 2 - 230}" y="1356" width="460" height="8" fill="${RED}"/>`);
    const price = await L("V", E.text(W / 2, 1530, inr(M.price), { size: 150, font: SANS, weight: 700, color: "#fff" }) + E.text(W / 2, 1610, `${off}% off · ${M.code} ${sizeLabel(M.dims)} canvas`, { size: 40, font: SANS, color: SAFFRON }));
    const band = await L("V", `<rect y="1150" width="${W}" height="770" fill="url(#fadeBottom)"/>` + E.text(W / 2, 1260, short, { size: 56, font: SERIF, italic: true }));
    return { shots: [shot("V", PRINT, 7, R.upper, R.rama, [{ png: band, start: 0.2 }, { png: mrp, start: 1.2, fade: 0.4 }, { png: strike, start: 2.2, fade: 0.2 }, { png: price, start: 2.8, fade: 0.3, rise: 50 }]), await endShot("V")], audio: audio.bell };
  });

  add(22, "Packed With Care", "S", "Packaging and frame build graphics with 'Free shipping, 4-layer protection'. Reduces damage-in-transit anxiety for large canvases.", async () => {
    const pk = features.find((f) => /packaging/.test(f)), bl = features.find((f) => /built/.test(f));
    return {
      shots: [
        shot("S", room("living-room"), 2.6, { cx: 0.46, cy: 0.33, h: 0.7 }, { cx: 0.46, cy: 0.33, h: 0.55 }, [{ png: await caption("S", "Worried about delivery?", null, { top: true }), start: 0.3 }]),
        ...(bl ? [shot("S", bl, 3, R.full, { cx: 0.5, cy: 0.5, h: 0.97 })] : []),
        ...(pk ? [shot("S", pk, 3, R.full, { cx: 0.5, cy: 0.5, h: 0.97 })] : []),
        await endShot("S"),
      ], audio: audio.drone,
    };
  });

  add(23, "Spec Sheet", "L", "A clean 16:9 product card: framed print on the left, sizes, frames, material and price appearing line by line. Ideal for YouTube Shopping.", async () => {
    const [W, H] = FMT.L;
    const fr = await framedPng(path.join(work, "spec-frame.png"), { pw: 560, frame: "Wooden" });
    const fb64 = "data:image/png;base64," + fs.readFileSync(fr.file).toString("base64");
    const base = await still("L", `<image href="${fb64}" x="${480 - fr.W / 2}" y="${H / 2 - fr.H / 2}" width="${fr.W}" height="${fr.H}"/>` + wrap(short, 26).map((t, i) => E.text(960, 230 + i * 74, t, { size: 62, font: SERIF, italic: true, color: INK, anchor: "start", shadow: false })).join(""));
    const rows = [
      ["Sizes", `${product.sizes.map((s) => s.dims.replace(/"/g, "")).join(" · ")} in`],
      ["Frames", M.frames.join(", ")],
      ["Material", "Fine Art Paper (XS, S) · Canvas (M, L, XL)"],
      ["Price", `${inr(from.price)} to ${inr(product.sizes.at(-1).price)} · Free shipping`],
    ];
    const layers = [];
    for (const [i, [k, v]] of rows.entries()) layers.push({ png: await L("L", E.text(960, 420 + i * 120, k.toUpperCase(), { size: 26, font: SANS, weight: 700, color: GOLD, anchor: "start", shadow: false, spacing: 3 }) + E.text(960, 466 + i * 120, v, { size: 36, font: SANS, color: INK, anchor: "start", shadow: false })), start: 0.8 + i * 1, fade: 0.5, rise: 16 });
    return { shots: [shot("L", base, 8, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.5, h: 0.97 }, layers), await endShot("L")], audio: audio.drone };
  });

  add(24, "YouTube Shopping Landscape", "L", "Cinematic 16:9: the camera travels down the painting while a side panel lists why it belongs in your home. Fills the frame, no black bars.", async () => {
    const [W, H] = FMT.L;
    const panel = (lines) => `<linearGradient id="rp" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.78"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient><rect x="${W * 0.38}" width="${W * 0.62}" height="${H}" fill="url(#rp)"/>` + lines;
    const l1 = await L("L", panel(E.text(W - 110, 470, short, { size: 64, font: SERIF, italic: true, anchor: "end" }) + E.text(W - 110, 550, "Vintage devotional print", { size: 38, font: SANS, color: "#f1e7d6", anchor: "end" })));
    const l2 = await L("L", panel(E.text(W - 110, 470, "For the pooja room,", { size: 60, font: SERIF, italic: true, anchor: "end" }) + E.text(W - 110, 550, "living room or entrance", { size: 60, font: SERIF, italic: true, anchor: "end" })));
    const l3 = await L("L", panel(E.text(W - 110, 470, `From ${inr(from.price)}`, { size: 72, font: SANS, weight: 700, anchor: "end" }) + E.text(W - 110, 550, `${product.sizes.length} sizes · ${M.frames.length} frames · Free shipping`, { size: 38, font: SANS, color: SAFFRON, anchor: "end" })));
    return {
      shots: [
        shot("L", PRINT, 5, { cx: 0.45, cy: 0.12, h: 0.4 }, { cx: 0.45, cy: 0.38, h: 0.4 }, [{ png: l1, start: 0.5 }], { ease: "linear" }),
        shot("L", PRINT, 5, { cx: 0.45, cy: 0.42, h: 0.4 }, { cx: 0.45, cy: 0.68, h: 0.4 }, [{ png: l2, start: 0.5 }], { ease: "linear" }),
        shot("L", PRINT, 4, { cx: 0.45, cy: 0.72, h: 0.4 }, { cx: 0.45, cy: 0.88, h: 0.4 }, [{ png: l3, start: 0.5 }], { ease: "linear" }),
        await endShot("L"),
      ], audio: audio.drone,
    };
  });

  add(25, "6-Second Bumper", "V", "The shortest length Google accepts: a quick zoom, one line, the logo. For Demand Gen and YouTube bumper slots.", async () => ({
    shots: [
      shot("V", PRINT, 4.1, { ...R.full, h: 0.95 }, { ...R.rama, h: 0.4 }, [{ png: await caption("V", "Bring the Darbar home.", `From ${inr(from.price)}`, { dev: "जय श्री राम" }), start: 0.3, fade: 0.4, rise: 30 }]),
      await endShot("V", 2.9),
    ], audio: audio.bell, transition: 0.5,
  }));

  add(26, "More Ram Darbar Styles", "S", "Cross-sell: this print plus three other Rama paintings from the catalog, each named. Works as a collection ad.", async () => {
    const store = JSON.parse(fs.readFileSync(path.join(HOME, "catalog-products.json"), "utf8"));
    const titles = Object.fromEntries(Object.values(store.products || store).map((p) => [String(p.productId), p.title]));
    const items = [{ file: PRINT, title: short }, ...related.map((n) => ({ file: assignments[n].image, title: (titles[n] || "").split(":")[0] }))];
    const shots = [];
    for (const it of items) {
      const sq = path.join(work, `xs-${path.basename(it.file)}.jpg`);
      await sharp(it.file).resize(1080, 1080, { fit: "contain", background: CREAM }).jpeg({ quality: 92 }).toFile(sq);
      shots.push(shot("S", sq, 2.6, { cx: 0.5, cy: 0.5, h: 1 }, { cx: 0.5, cy: 0.5, h: 0.9 }, [{ png: await caption("S", wrap(it.title, 28)[0], wrap(it.title, 28).slice(1).join(" ") || null), start: 0.3 }]));
    }
    shots.unshift(shot("S", room("pooja-room"), 2.4, { cx: 0.5, cy: 0.45, h: 0.6 }, { cx: 0.5, cy: 0.45, h: 0.5 }, [{ png: await caption("S", "Find your Ram Darbar", null, { top: true }), start: 0.3 }]));
    shots.push(await endShot("S"));
    return { shots, audio: audio.drone, transition: 0.5 };
  });

  add(27, "Ram Naam", "V", "The Ram dhun 'श्री राम जय राम जय जय राम' appears line by line over a slow zoom with a tanpura-style drone. Devotional content people replay and share.", async () => {
    const [W, H] = FMT.V;
    const lines = ["श्री राम", "जय राम", "जय जय राम"];
    const layers = [{ png: await L("V", `<rect y="${H * 0.55}" width="${W}" height="${H * 0.45}" fill="url(#fadeBottom)"/>`), start: 0 }];
    for (const [i, t] of lines.entries()) layers.push({ png: await L("V", E.text(W / 2, 1450 + i * 120, t, { size: 92, font: DEV, weight: 700, color: SAFFRON })), start: 1 + i * 1.6, fade: 0.8, rise: 20 });
    return { shots: [shot("V", PRINT, 9, { ...R.full, h: 0.85 }, R.upper, layers), await endShot("V")], audio: audio.drone };
  });

  add(28, "From the Archive", "V", "Opens in sepia and blooms into full colour: 'a vintage devotional print, reproduced in rich colour for your walls'.", async () => ({
    shots: [
      shot("V", PRINT, 8, R.full, { ...R.upper, h: 0.7 }, [{ png: await caption("V", "From the archive", "to your walls, in full colour"), start: 3.6, fade: 0.8, rise: 24 }], { post: `hue=s='min(1\\,max(0\\,(t-1)/3.5))',eq=gamma_r='1+0.12*max(0\\,1-(t-1)/3.5)':gamma_b='1-0.1*max(0\\,1-(t-1)/3.5)':eval=frame` }),
      await endShot("V"),
    ], audio: audio.drone,
  }));

  add(29, "3D Frame Tilt", "S", "The framed print floats on a cream wall and slowly tilts in 3D, catching the light. A premium 'object' look without a photoshoot.", async () => {
    const [W, H] = FMT.S;
    const fr = await framedPng(path.join(work, "tilt-frame.png"), { pw: 640, frame: "Wooden", shadow: false });
    const padded = path.join(work, "tilt-padded.png");
    await sharp(fr.file).extend({ top: 120, bottom: 120, left: 160, right: 160, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(padded);
    const pm = await sharp(padded).metadata();
    const bg = await still("S", `<radialGradient id="rg" cx="0.5" cy="0.45" r="0.75"><stop offset="0" stop-color="#FBF6EC"/><stop offset="1" stop-color="#E6D8C1"/></radialGradient><rect width="${W}" height="${H}" fill="url(#rg)"/><ellipse cx="${W / 2}" cy="${H - 120}" rx="300" ry="26" fill="#000" fill-opacity="0.12"/>`);
    const out = path.join(work, "s29-tilt.mp4");
    const dur = 7, a = `(0.17*sin(2*PI*on/${dur * E.FPS}))`, iw = pm.width;
    const fx = 160, fy = 120, fw = fr.W, fh = fr.H;
    const left = `${fh}*abs(${a})*0.5*gt(${a}\\,0)`, right = `${fh}*abs(${a})*0.5*lt(${a}\\,0)`;
    const persp = `perspective=x0='${fx}+${fw}*max(0\\,${a})':y0='${fy}+${left}':x1='${fx + fw}-${fw}*max(0\\,-${a})':y1='${fy}+${right}':x2='${fx}+${fw}*max(0\\,${a})':y2='${fy + fh}-${left}':x3='${fx + fw}-${fw}*max(0\\,-${a})':y3='${fy + fh}-${right}':sense=destination:eval=frame`;
    const scaleW = Math.round(iw * 0.9 / 2) * 2;
    E.ffmpeg(["-loop", "1", "-t", String(dur + 1), "-i", bg, "-loop", "1", "-t", String(dur + 1), "-i", padded, "-filter_complex",
      `[1]format=rgba,${persp},scale=${scaleW}:-2[f];[0]format=rgba[b];[b][f]overlay=x=(W-w)/2:y=(H-h)/2-30,format=yuv420p[v]`, "-map", "[v]", "-frames:v", String(dur * E.FPS), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(E.FPS), out], "tilt");
    const label = await L("S", E.text(W / 2, 110, short, { size: 60, font: SERIF, italic: true, color: INK, shadow: false }) + E.text(W / 2, 165, `From ${inr(from.price)} · ${M.frames.length} frame styles`, { size: 32, font: SANS, color: "#555", shadow: false }));
    return { prebuilt: [out], shots: [await endShot("S")], audio: audio.drone, overlayFirst: label };
  });

  add(30, "Floating Gallery", "V", "Depth effect: a blurred, slowly moving painting as backdrop with the framed print floating and drifting in front. Feels 3D for zero cost.", async () => {
    const [W, H] = FMT.V;
    const bgShot = path.join(work, "s30-bg.mp4");
    await E.renderShot(shot("V", PRINT, 8, R.full, R.upper, [], { post: "gblur=sigma=26,eq=brightness=-0.2:saturation=1.15,vignette=PI/4" }), bgShot);
    const fr = await framedPng(path.join(work, "float-frame.png"), { pw: 720, frame: "Dark Brown" });
    const out = path.join(work, "s30-float.mp4");
    const inputs = ["-i", bgShot, "-loop", "1", "-t", "9", "-i", fr.file];
    const fc = `[1]format=rgba[f];[0][f]overlay=x=(W-w)/2:y='(H-h)/2-60-30*sin(2*PI*t/8)',format=yuv420p[v]`;
    E.ffmpeg([...inputs, "-filter_complex", fc, "-map", "[v]", "-frames:v", String(8 * E.FPS), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(E.FPS), out], "float");
    const label = await caption("V", short, "Vintage devotional print");
    return { prebuilt: [out], shots: [await endShot("V")], audio: audio.drone, overlayFirst: label };
  });

  // --- render ---
  const results = [];
  for (const c of C) {
    if (ONLY && !ONLY.has(c.id)) continue;
    const [W, H, ratio] = FMT[c.fmt];
    const name = `${String(c.id).padStart(2, "0")} ${c.title.replace(/[?\/\\:*"<>|]/g, "")} (${ratio}).mp4`;
    assertClean(name, "video file name");
    const t0 = Date.now();
    try {
      const spec = await c.build();
      const files = [];
      for (const [i, pre] of (spec.prebuilt || []).entries()) {
        if (i === 0 && spec.overlayFirst) {
          const withLabel = pre.replace(/\.mp4$/, "-label.mp4");
          E.ffmpeg(["-i", pre, "-loop", "1", "-i", spec.overlayFirst, "-filter_complex", `[1]format=rgba,fade=t=in:st=1:d=0.8:alpha=1[l];[0][l]overlay=0:0:shortest=1,format=yuv420p[v]`, "-map", "[v]", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", withLabel], "label");
          files.push(withLabel);
        } else files.push(pre);
      }
      for (const [i, s] of spec.shots.entries()) files.push(await E.renderShot(s, path.join(work, `c${c.id}-s${i}.mp4`)));
      const { duration } = E.joinShots(files, path.join(dir, name), { transition: spec.transition ?? 0.6, transitionType: spec.transitionType || "fade", audio: spec.audio, audioVolume: 0.9 });
      E.ffmpeg(["-ss", String(Math.min(2.5, duration / 2)), "-i", path.join(dir, name), "-frames:v", "1", "-vf", `scale=${Math.round(W / 3)}:-2`, path.join(work, `thumb-${String(c.id).padStart(2, "0")}.jpg`)], "thumb");
      results.push({ id: c.id, title: c.title, ratio, file: name, duration: Math.round(duration * 10) / 10, pitch: c.pitch });
      console.log(`${name}  ${duration.toFixed(1)}s  (${Math.round((Date.now() - t0) / 1000)}s to render)`);
    } catch (e) {
      console.error(`${name} FAILED: ${e.message}`);
      results.push({ id: c.id, title: c.title, ratio, failed: e.message });
    }
  }
  const indexFile = path.join(dir, "_videos.json");
  const prev = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : [];
  const merged = [...prev.filter((p) => !results.some((r) => r.id === p.id)), ...results].sort((a, b) => a.id - b.id);
  fs.writeFileSync(indexFile, JSON.stringify(merged, null, 1));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
