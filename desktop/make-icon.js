/** Builds editpro.ico (PNG-in-ICO, 16 to 256 px) from public/favicon.png. */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require(path.join(__dirname, "..", "node_modules", "sharp"));

const SRC = path.join(__dirname, "..", "public", "favicon.png");
const OUT = path.join(__dirname, "editpro.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const pngs = await Promise.all(SIZES.map((s) => sharp(SRC).resize(s, s).png().toBuffer()));
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    const e = 6 + 16 * i, s = SIZES[i] === 256 ? 0 : SIZES[i];
    header.writeUInt8(s, e);
    header.writeUInt8(s, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  fs.writeFileSync(OUT, Buffer.concat([header, ...pngs]));
  console.log(OUT);
})();
