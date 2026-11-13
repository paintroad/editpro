/**
 * Small local video engine (FFmpeg + sharp, no paid calls).
 * A video is a list of shots joined with dissolves. A shot is a slow zoom/pan over an image
 * (or a still layout) with full-frame PNG layers that fade in and out.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const sharp = require("sharp");

const FPS = 30;
const CREAM = "#F8F1E6";

function ffmpeg(args, label) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${label}): ${r.stderr.slice(-1500)}`);
}

function probeDuration(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return Number(r.stdout.trim());
}

const ENCODE = ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(FPS)];

/** Window in image pixels for a view {cx, cy, h}: centre as fractions of the image, h = visible height fraction. */
function windowFor(view, imgW, imgH, W, H) {
  let vh = view.h * imgH;
  let vw = (vh * W) / H;
  if (vw > imgW) { vw = imgW; vh = (vw * H) / W; }
  if (vh > imgH) { vh = imgH; vw = (vh * W) / H; }
  const cx = Math.min(Math.max(view.cx * imgW, vw / 2), imgW - vw / 2);
  const cy = Math.min(Math.max(view.cy * imgH, vh / 2), imgH - vh / 2);
  return { cx, cy, vw, vh };
}

/**
 * Render one shot.
 * shot: { src, W, H, dur, from, to, layers: [{ png, start, end, fade, rise }], post, ease }
 */
async function renderShot(shot, out) {
  const { src, W, H, dur } = shot;
  const meta = await sharp(src).metadata();
  const imgW = meta.width, imgH = meta.height;
  const from = windowFor(shot.from || { cx: 0.5, cy: 0.5, h: 1 }, imgW, imgH, W, H);
  const to = windowFor(shot.to || shot.from || { cx: 0.5, cy: 0.5, h: 1 }, imgW, imgH, W, H);

  // Canvas with the output aspect so zoompan keeps the right proportions; the window never leaves the image.
  const CW = Math.max(imgW, (imgH * W) / H);
  const CH = (CW * H) / W;
  const ox = (CW - imgW) / 2, oy = (CH - imgH) / 2;
  const minVw = Math.min(from.vw, to.vw);
  const P = Math.min(7200 / CW, Math.max(1, (3 * W) / minVw));
  const SW = Math.round((CW * P) / 2) * 2, SH = Math.round((SW * H) / W / 2) * 2;
  const N = Math.round(dur * FPS);

  const t = `(on/${Math.max(1, N - 1)})`;
  const e = shot.ease === "linear" ? t : `(${t}*${t}*(3-2*${t}))`;
  const vw = `(${from.vw}*pow(${to.vw / from.vw},${e}))`;
  const vh = `(${vw}*${H / W})`;
  const cx = `(${from.cx}+(${to.cx - from.cx})*${e})`;
  const cy = `(${from.cy}+(${to.cy - from.cy})*${e})`;
  const z = `${SW}/(${vw}*${P})`;
  const x = `(${ox}+${cx}-${vw}/2)*${P}`;
  const y = `(${oy}+${cy}-${vh}/2)*${P}`;

  const args = ["-i", src];
  const layers = shot.layers || [];
  for (const l of layers) args.push("-loop", "1", "-t", String(dur + 1), "-i", l.png);
  const parts = [
    `[0]format=rgb24,pad=${Math.round(CW)}:${Math.round(CH)}:${Math.round(ox)}:${Math.round(oy)}:color=${CREAM},scale=${SW}:${SH}:flags=lanczos,` +
      `zoompan=z='${z}':x='${x}':y='${y}':d=${N}:s=${W}x${H}:fps=${FPS}${shot.post ? "," + shot.post : ""},setsar=1[b0]`,
  ];
  layers.forEach((l, i) => {
    const fade = l.fade ?? 0.5;
    const start = l.start ?? 0;
    const end = l.end ?? dur;
    let f = `[${i + 1}]format=rgba`;
    if (start > 0 || l.fadeFirst) f += `,fade=t=in:st=${start}:d=${fade}:alpha=1`;
    if (end < dur) f += `,fade=t=out:st=${Math.max(0, end - fade)}:d=${fade}:alpha=1`;
    parts.push(`${f}[l${i}]`);
    const rise = l.rise ?? 0;
    const yExpr = rise ? `'${rise}*max(0,1-(t-${start})/${fade * 1.6})'` : "0";
    parts.push(`[b${i}][l${i}]overlay=x=0:y=${yExpr}:shortest=1[b${i + 1}]`);
  });
  args.push("-filter_complex", parts.join(";"), "-map", `[b${layers.length}]`, "-frames:v", String(N), ...ENCODE, out);
  ffmpeg(args, path.basename(out));
  return out;
}

/** Join shot files with dissolves (or cuts), add optional audio, write the final MP4. */
function joinShots(files, out, { transition = 0.6, transitionType = "fade", audio = null, audioVolume = 1 } = {}) {
  const durs = files.map(probeDuration);
  const total = durs.reduce((a, b) => a + b, 0) - transition * (files.length - 1);
  const args = [];
  files.forEach((f) => args.push("-i", f));
  const parts = [];
  let last = "[0:v]";
  let offset = 0;
  for (let i = 1; i < files.length; i++) {
    offset += durs[i - 1] - transition;
    const label = `[x${i}]`;
    const type = Array.isArray(transitionType) ? transitionType[i - 1] : transitionType;
    parts.push(`${last}[${i}:v]xfade=transition=${type}:duration=${transition}:offset=${offset.toFixed(3)}${label}`);
    last = label;
  }
  if (files.length === 1) parts.push(`[0:v]null[x0]`), (last = "[x0]");
  let audioMap = [];
  if (audio) {
    args.push("-i", audio);
    const ai = files.length;
    parts.push(`[${ai}:a]atrim=0:${total.toFixed(3)},volume=${audioVolume},afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, total - 1.2).toFixed(3)}:d=1.2[a]`);
    audioMap = ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"];
  }
  args.push("-filter_complex", parts.join(";"), "-map", last, ...audioMap,
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", "-t", total.toFixed(3), out);
  ffmpeg(args, path.basename(out));
  return { out, duration: total };
}

/** Full-frame transparent PNG from SVG body (W x H). */
async function layerPng(file, W, H, body, { background = null } = {}) {
  const bg = background ? `<rect width="${W}" height="${H}" fill="${background}"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">${bg}${body}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Text with a soft shadow for legibility over art. */
function text(x, y, str, { size = 48, font = "Segoe UI", weight = 400, color = "#fff", anchor = "middle", italic = false, shadow = true, spacing = 0 } = {}) {
  const style = `font-family="${font}" font-size="${size}" font-weight="${weight}"${italic ? ' font-style="italic"' : ""} text-anchor="${anchor}" letter-spacing="${spacing}"`;
  const sh = shadow ? `<text x="${x + 2}" y="${y + 3}" ${style} fill="#000" fill-opacity="0.45" filter="url(#blur)">${esc(str)}</text>` : "";
  return `${sh}<text x="${x}" y="${y}" ${style} fill="${color}">${esc(str)}</text>`;
}
const DEFS = `<defs><filter id="blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="4"/></filter>
<linearGradient id="fadeTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.65"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
<linearGradient id="fadeBottom" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.7"/></linearGradient></defs>`;

/** Generated audio, no licences needed: a soft tanpura-like drone and a temple bell. */
function makeAudio(dir) {
  const drone = path.join(dir, "drone.m4a");
  const bell = path.join(dir, "bell.m4a");
  const droneBell = path.join(dir, "drone-bell.m4a");
  if (!fs.existsSync(drone)) {
    const note = (offset, f) => {
      const u = `mod(t+${2.4 - offset},2.4)`;
      return `exp(-1.3*${u})*(sin(2*PI*${f}*${u})+0.5*sin(4*PI*${f}*${u})+0.33*sin(6*PI*${f}*${u})+0.2*sin(8*PI*${f}*${u}))`;
    };
    const expr = `0.12*(${note(0, 196)}+${note(0.6, 261.63)}+${note(1.2, 261.63)}+${note(1.8, 130.81)})`;
    ffmpeg(["-f", "lavfi", "-i", `aevalsrc='${expr}':s=44100:d=40`, "-af", "aecho=0.8:0.7:60|120:0.35|0.2,lowpass=f=3500,volume=1.6", "-c:a", "aac", "-b:a", "160k", drone], "drone");
  }
  if (!fs.existsSync(bell)) {
    const p = [[523, 1, 0.9], [1046, 0.5, 1.4], [1379, 0.35, 1.9], [1760, 0.25, 2.6], [2489, 0.15, 3.4]];
    const expr = p.map(([f, a, d]) => `${a}*exp(-${d}*t)*sin(2*PI*${f}*t)`).join("+");
    ffmpeg(["-f", "lavfi", "-i", `aevalsrc='0.25*(${expr})':s=44100:d=4`, "-af", "aecho=0.8:0.6:80:0.3", "-c:a", "aac", "-b:a", "160k", bell], "bell");
  }
  if (!fs.existsSync(droneBell)) {
    ffmpeg(["-i", drone, "-i", bell, "-filter_complex", "[1]adelay=200|200[b];[0][b]amix=inputs=2:duration=first:normalize=0", "-c:a", "aac", "-b:a", "160k", droneBell], "drone-bell");
  }
  return { drone, bell, droneBell };
}

module.exports = { FPS, CREAM, ffmpeg, probeDuration, renderShot, joinShots, layerPng, text, esc, DEFS, makeAudio, windowFor };
