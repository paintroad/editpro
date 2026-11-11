// Builds audit/changelog.json and catalog-audit-changelog.xlsx from proposal.json + structure.json.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const rb = require('./rulebook');

const ROOT = path.join(process.env.USERPROFILE, 'Downloads', '_Catalog', 'Catalog Audit');
const A = path.join(ROOT, 'audit');
const proposal = JSON.parse(fs.readFileSync(path.join(A, 'proposal.json'), 'utf8'));
const structure = JSON.parse(fs.readFileSync(path.join(A, 'structure.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(path.join(A, 'stats.json'), 'utf8'));
const titleOf = Object.fromEntries(structure.map((s) => [s.handle, s.title]));
const t = (h) => titleOf[h] || h;

const changed = proposal.filter((r) => r.changes.length || (r.notes && r.notes.length));
const changelog = {
  generatedAt: new Date().toISOString(), stats, principles: rb.principles, rules: rb.rules,
  collectionChanges: rb.collectionChanges, newCollections: rb.newCollections.map(({ handle, title, tag, parent, promise }) => ({ handle, title, tag, parent, promise })),
  collections: structure,
  rooms: rb.rooms.map(({ handle, title, isNew, promise }) => ({ handle, title, isNew: !!isNew, promise: promise || '' })),
  products: changed.map((r) => ({ id: r.id, handle: r.handle, title: r.title, family: r.family, before: r.before, after: r.after, changes: r.changes, notes: r.notes, tagOps: r.tagOps })),
};
fs.writeFileSync(path.join(A, 'changelog.json'), JSON.stringify(changelog));

(async () => {
  const wb = new ExcelJS.Workbook();
  const head = (ws, cols) => { ws.columns = cols; ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }]; ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } }; };

  const r1 = wb.addWorksheet('Rulebook');
  head(r1, [{ header: 'ID', key: 'id', width: 8 }, { header: 'Rule', key: 'title', width: 40 }, { header: 'What it does', key: 'text', width: 110 }, { header: 'Confidence', key: 'confidence', width: 12 }]);
  rb.principles.forEach((p, i) => r1.addRow({ id: `P${i + 1}`, title: 'Principle', text: p, confidence: '' }));
  rb.rules.forEach((r) => r1.addRow(r));
  for (const [h, d] of Object.entries(rb.collections)) if (d.promise) r1.addRow({ id: '', title: `${t(h)} (${h})`, text: `${d.family}: ${d.promise}`, confidence: '' });

  const p = wb.addWorksheet('Product changes');
  head(p, [{ header: 'Product', key: 'title', width: 50 }, { header: 'Handle', key: 'handle', width: 40 }, { header: 'Family', key: 'family', width: 20 },
    { header: 'Change', key: 'action', width: 9 }, { header: 'Collection', key: 'collection', width: 28 }, { header: 'Rule', key: 'rule', width: 7 },
    { header: 'Reason', key: 'reason', width: 70 }, { header: 'Confidence', key: 'confidence', width: 11 }, { header: 'URL', key: 'url', width: 50 }]);
  for (const r of changed) {
    for (const c of r.changes) p.addRow({ title: r.title, handle: r.handle, family: r.family, action: c.action, collection: t(c.collection), rule: c.rule, reason: c.reason, confidence: c.confidence, url: r.url });
    for (const n of r.notes || []) p.addRow({ title: r.title, handle: r.handle, family: r.family, action: 'keep', collection: '', rule: 'Visual', reason: n, confidence: 'checked', url: r.url });
  }

  const c = wb.addWorksheet('Collection changes');
  head(c, [{ header: 'Collection', key: 'title', width: 32 }, { header: 'Handle', key: 'handle', width: 30 }, { header: 'Family', key: 'family', width: 22 },
    { header: 'New?', key: 'isNew', width: 6 }, { header: 'Products now', key: 'before', width: 12 }, { header: 'Products after', key: 'after', width: 13 },
    { header: 'Added', key: 'added', width: 8 }, { header: 'Removed', key: 'removed', width: 9 }, { header: 'Promise', key: 'promise', width: 60 },
    { header: 'Collection-level change', key: 'change', width: 80 }]);
  for (const s of structure) {
    const cc = rb.collectionChanges.filter((x) => x.handle === s.handle).map((x) => `${x.type}: ${x.change}`).join(' | ');
    c.addRow({ ...s, isNew: s.isNew ? 'NEW' : '', change: cc });
  }

  const n = wb.addWorksheet('Nested map');
  head(n, [{ header: 'Parent', key: 'parent', width: 30 }, { header: 'Child', key: 'child', width: 32 }, { header: 'Child products', key: 'count', width: 14 },
    { header: 'Current parent', key: 'current', width: 30 }, { header: 'Status', key: 'status', width: 20 }]);
  for (const s of structure.filter((x) => x.children.length)) {
    for (const k of s.children) {
      const child = structure.find((x) => x.handle === k) || {};
      n.addRow({ parent: t(s.handle), child: t(k), count: child.after, current: child.currentParent ? t(child.currentParent) : '', status: child.currentParent === s.handle ? 'unchanged' : child.currentParent ? 'moved' : child.isNew ? 'new collection' : 'new link' });
    }
    for (const k of s.currentChildren.filter((x) => !s.children.includes(x))) n.addRow({ parent: t(s.handle), child: t(k), count: '', current: t(s.handle), status: 'removed from this parent' });
  }

  const rel = wb.addWorksheet('Related map');
  head(rel, [{ header: 'Collection', key: 'title', width: 32 }, ...Array.from({ length: 8 }, (_, i) => ({ header: `Related ${i + 1}`, key: `r${i}`, width: 24 }))]);
  for (const s of structure.filter((x) => !x.hidden)) {
    const row = { title: t(s.handle) };
    s.related.forEach((r, i) => { row[`r${i}`] = `${t(r.handle)}${r.why === 'curated' ? '' : ` (${r.why})`}`; });
    rel.addRow(row);
  }

  const tg = wb.addWorksheet('Tag cleanup');
  head(tg, [{ header: 'Product', key: 'title', width: 50 }, { header: 'Op', key: 'op', width: 8 }, { header: 'Tags', key: 'tags', width: 40 },
    { header: 'For collection', key: 'for', width: 28 }, { header: 'Warning', key: 'warn', width: 70 }]);
  for (const r of changed) for (const o of r.tagOps || []) {
    tg.addRow({ title: r.title, op: o.op, tags: o.op === 'add' ? o.tag : o.tags.join(', '), for: t(o.for),
      warn: o.op === 'remove' && o.sideEffects && o.sideEffects.length ? `Removing these tags would also drop: ${o.sideEffects.map(t).join(', ')}. Use a different tag or an exclusion.` : o.op === 'remove' && !o.tags.length ? 'No matching tag (rule change handles it)' : '' });
  }

  const rm = wb.addWorksheet('Best room');
  head(rm, [{ header: 'Product', key: 'title', width: 50 }, { header: 'Best room', key: 'room', width: 16 }, { header: 'Confidence', key: 'confidence', width: 11 },
    { header: 'Why', key: 'reason', width: 70 }, { header: 'Runner-up', key: 'alt', width: 30 }, { header: 'URL', key: 'url', width: 50 }]);
  for (const r of proposal) rm.addRow({ title: r.title, room: r.room.title, confidence: r.room.confidence, reason: r.room.reason, alt: r.room.alternatives.map((a) => a.title).join(', '), url: r.url });

  const file = path.join(ROOT, 'catalog-audit-changelog.xlsx');
  await wb.xlsx.writeFile(file);
  console.log({ changedProducts: changed.length, rows: p.rowCount - 1, file });
})();
