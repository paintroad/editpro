// Turns visual-decisions.js + audit/sheets/index.json into audit/visual.json (product-id based), read by audit.js.
const fs = require('fs');
const path = require('path');
const decisions = require('./visual-decisions');

const OUT = path.join(process.env.USERPROFILE, 'Downloads', '_Catalog', 'Catalog Audit', 'audit');
const index = JSON.parse(fs.readFileSync(path.join(OUT, 'sheets', 'index.json'), 'utf8'));
const visualFile = path.join(OUT, 'visual.json');
const visual = fs.existsSync(visualFile) ? JSON.parse(fs.readFileSync(visualFile, 'utf8')) : {};

const byCollection = {};
for (const s of index) for (const it of s.items) (byCollection[s.collection] = byCollection[s.collection] || {})[it.n] = it;

let kept = 0, confirmed = 0, added = 0;
for (const [h, items] of Object.entries(byCollection)) {
  const d = decisions[h];
  if (!d) { console.warn('No decision for', h); continue; }
  for (const [n, it] of Object.entries(items)) {
    const v = (visual[it.id] = visual[it.id] || { keep: [], confirm: [], add: [] });
    if (d.keep.includes(Number(n))) { if (!v.keep.includes(h)) v.keep.push(h); kept++; }
    else { if (!v.confirm.includes(h)) v.confirm.push(h); confirmed++; }
  }
  for (const [target, nums] of Object.entries(d.add || {})) {
    for (const n of nums) {
      const it = items[n];
      if (!it) { console.warn('Missing tile', h, n); continue; }
      const v = visual[it.id];
      if (!v.add.includes(target)) v.add.push(target);
      added++;
    }
  }
}
fs.writeFileSync(visualFile, JSON.stringify(visual, null, 1));
console.log({ kept, confirmed, added, products: Object.keys(visual).length });
