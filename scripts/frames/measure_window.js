// Measure the flat grey placeholder window in a room template and check it against the
// painting shape. Usage:
//   node scripts/frames/measure_window.js <portrait|landscape|square> <image...>
// Prints one JSON line per image: bbox on a 1080 canvas, aspect, fill (rectangularity), pass.
const sharp = require("sharp");

const TARGET = { portrait: 3 / 4, landscape: 4 / 3, square: 1 };
const MAX_SAT = 24;
const MIN_LUM = 150;
const MAX_LUM = 236;
const MAX_GRAD = 6;
const MAX_ASPECT_ERROR = 0.03;
const MIN_FILL = 0.97;
const MIN_AREA = 0.04;

async function measure(file, orientation) {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .resize(1080, 1080, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  // Placeholder pixels: neutral grey (low saturation, mid-light) with almost no local texture.
  const lum = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = 0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2];
  const grey = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const o = i * 3;
      const sat = Math.max(data[o], data[o + 1], data[o + 2]) - Math.min(data[o], data[o + 1], data[o + 2]);
      const grad = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + W] - lum[i - W]);
      grey[i] = sat <= MAX_SAT && lum[i] >= MIN_LUM && lum[i] <= MAX_LUM && grad <= MAX_GRAD ? 1 : 0;
    }
  }

  const seen = new Uint8Array(W * H);
  let best = null;
  for (let start = 0; start < W * H; start++) {
    if (!grey[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let n = 0;
    let minx = W, miny = H, maxx = 0, maxy = 0;
    while (stack.length) {
      const k = stack.pop();
      const x = k % W;
      const y = (k - x) / W;
      n++;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      for (const nb of [k - 1, k + 1, k - W, k + W]) {
        if (nb < 0 || nb >= W * H || seen[nb] || !grey[nb]) continue;
        if ((nb === k - 1 && x === 0) || (nb === k + 1 && x === W - 1)) continue;
        seen[nb] = 1;
        stack.push(nb);
      }
    }
    const fillRatio = n / ((maxx - minx + 1) * (maxy - miny + 1));
    if (fillRatio < 0.9 || n < W * H * 0.01) continue;
    if (!best || n > best.n) best = { n, minx, miny, maxx, maxy };
  }
  if (!best) return { file, pass: false, reason: "no grey window" };

  const w = best.maxx - best.minx + 1;
  const h = best.maxy - best.miny + 1;
  const aspect = w / h;
  const target = TARGET[orientation];
  const error = Math.abs(aspect / target - 1);
  const fill = best.n / (w * h);
  const area = (w * h) / (W * H);
  const reasons = [];
  if (error > MAX_ASPECT_ERROR) reasons.push(`aspect ${aspect.toFixed(3)} vs ${target.toFixed(3)}`);
  if (fill < MIN_FILL) reasons.push(`not a clean rectangle (fill ${fill.toFixed(3)})`);
  if (area < MIN_AREA) reasons.push(`window too small (${(area * 100).toFixed(1)}%)`);
  return {
    file,
    pass: reasons.length === 0,
    bbox: [best.minx, best.miny, best.maxx, best.maxy],
    aspect: Number(aspect.toFixed(4)),
    errorPct: Number((error * 100).toFixed(1)),
    fill: Number(fill.toFixed(3)),
    areaPct: Number((area * 100).toFixed(1)),
    reasons,
  };
}

(async () => {
  const [orientation, ...files] = process.argv.slice(2);
  if (!TARGET[orientation]) throw new Error("orientation must be portrait, landscape or square");
  for (const file of files) console.log(JSON.stringify(await measure(file, orientation)));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
