// Renders contact sheets of low-confidence changes for visual checking (no paid APIs).
// Usage: node sheets.js   -> audit/sheets/*.png + audit/sheets/index.json
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(process.env.TEMP, 'pr-pw', 'node_modules', 'playwright'));

const ROOT = path.join(process.env.USERPROFILE, 'Downloads', '_Catalog', 'Catalog Audit');
const OUT = path.join(ROOT, 'audit', 'sheets');
fs.mkdirSync(OUT, { recursive: true });
const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit', 'proposal.json'), 'utf8'));
const summary = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit', 'collections-summary.json'), 'utf8'));
const titleOf = (h) => (summary.find((s) => s.handle === h) || {}).title || h;

const groups = {};
for (const r of results) for (const c of r.changes) if (c.confidence === 'low') (groups[c.collection] = groups[c.collection] || []).push({ r, c });

const PER = 30;
const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
const thumb = (u) => (u ? u + (u.includes('?') ? '&' : '?') + 'width=360' : '');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1456, height: 900 } });
  const index = [];
  for (const [h, items] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
    for (let i = 0; i < items.length; i += PER) {
      const chunk = items.slice(i, i + PER);
      const name = `${h}-${i / PER + 1}`;
      const tiles = chunk.map(({ r, c }, k) => `<div class="t"><img src="${esc(thumb(r.image))}"><div class="n">${i + k + 1}</div><div class="ti">${esc(r.title.slice(0, 60))}</div></div>`).join('');
      const html = `<html><head><style>body{margin:0;font:12px Arial;background:#fff}h1{font-size:18px;margin:8px 12px}.g{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;padding:6px}.t{position:relative;border:1px solid #ccc}.t img{width:100%;height:210px;object-fit:contain;background:#eee;display:block}.n{position:absolute;top:2px;left:2px;background:#000;color:#fff;font-weight:bold;padding:2px 6px;font-size:14px}.ti{padding:2px 4px;height:30px;overflow:hidden}</style></head><body><h1>${esc(titleOf(h))} (${h}) - proposed REMOVE - items ${i + 1}-${i + chunk.length} of ${items.length}</h1><div class="g">${tiles}</div></body></html>`;
      await page.setContent(html);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForFunction(() => [...document.images].every((im) => im.complete), null, { timeout: 30000 }).catch(() => {});
      const file = path.join(OUT, name + '.png');
      await page.screenshot({ path: file, fullPage: true });
      index.push({ sheet: name, collection: h, items: chunk.map(({ r, c }, k) => ({ n: i + k + 1, id: r.id, title: r.title, action: c.action, rule: c.rule })) });
      console.log(name, chunk.length);
    }
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  await browser.close();
})();
