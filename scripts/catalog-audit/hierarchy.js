// Builds audit/structure.json: proposed parent/children and related lists per collection, with counts and current state.
const fs = require('fs');
const path = require('path');
const { nested, related, hiddenFromRelated } = require('./structure');
const rb = require('./rulebook');

const ROOT = path.join(process.env.USERPROFILE, 'Downloads', '_Catalog', 'Catalog Audit');
const collections = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'collections.json'), 'utf8'));
const menus = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'menus.json'), 'utf8'));
const summary = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit', 'collections-summary.json'), 'utf8'));
const proposal = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit', 'proposal.json'), 'utf8'));

const byHandle = Object.fromEntries(summary.map((s) => [s.handle, s]));
const live = Object.fromEntries(collections.map((c) => [c.handle, c]));
const errors = [];

const parentOf = {};
for (const [p, kids] of Object.entries(nested)) {
  if (!byHandle[p]) errors.push(`Unknown parent ${p}`);
  for (const k of kids) {
    if (!byHandle[k]) errors.push(`Unknown child ${k} under ${p}`);
    if (parentOf[k]) errors.push(`${k} has two parents: ${parentOf[k]} and ${p}`);
    parentOf[k] = p;
  }
}
const currentParent = {};
for (const c of collections) for (const k of c.nested || []) if (!currentParent[k]) currentParent[k] = c.handle;

// Menu placement (where each collection is linked from the store menus)
const menuPlaces = {};
(function walk(items, trail) {
  for (const it of items || []) {
    const m = /\/collections\/([^/?#]+)/.exec(it.url || '');
    const t = [...trail, it.title];
    if (m) (menuPlaces[m[1]] = menuPlaces[m[1]] || []).push(t.join(' > '));
    walk(it.items, t);
  }
})(menus.flatMap((m) => (m.items || []).map((i) => ({ ...i, title: `${m.title}: ${i.title}` }))), []);

// Product overlap for related fill
const sets = {};
for (const r of proposal) for (const h of r.after) (sets[h] = sets[h] || new Set()).add(r.id);
const rooms = new Set(['living-room', 'bedroom', 'dining-room', 'study-room', 'entrance', 'kitchen', 'bathroom']);
const hidden = new Set(hiddenFromRelated);
function overlap(a, b) {
  const A = sets[a], B = sets[b];
  if (!A || !B) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
}

const out = [];
for (const s of summary) {
  const h = s.handle;
  if (hidden.has(h) && !nested[h]) { out.push({ ...s, parent: null, currentParent: currentParent[h] || null, children: [], currentChildren: (live[h] && live[h].nested) || [], related: [], currentRelated: (live[h] && live[h].related) || [], menus: menuPlaces[h] || [], hidden: true }); continue; }
  const children = nested[h] || [];
  const descendants = (x) => (nested[x] || []).flatMap((k) => [k, ...descendants(k)]);
  const exclude = new Set([h, ...descendants(h), ...hidden]);
  const list = [];
  const push = (x, why) => { if (list.length < 8 && !exclude.has(x) && byHandle[x] && !list.find((l) => l.handle === x)) list.push({ handle: x, why }); };
  for (const x of related[h] || []) push(x, 'curated');
  if (parentOf[h]) {
    for (const x of nested[parentOf[h]]) push(x, 'sibling');
    push(parentOf[h], 'parent');
  }
  if (list.length < 4 && !rooms.has(h)) {
    const cands = summary.map((o) => o.handle).filter((x) => !rooms.has(x) && !exclude.has(x) && x !== 'shop-by-rooms')
      .map((x) => [x, overlap(h, x)]).filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1]);
    for (const [x] of cands) if (list.length < 5) push(x, 'overlap');
  }
  if (rooms.has(h)) for (const x of nested['shop-by-rooms']) push(x, 'sibling');
  const errorsFor = [...(related[h] || [])].filter((x) => !byHandle[x]);
  for (const x of errorsFor) errors.push(`Unknown related ${x} on ${h}`);
  out.push({ ...s, parent: parentOf[h] || null, currentParent: currentParent[h] || null, children, currentChildren: (live[h] && live[h].nested) || [],
    related: list, currentRelated: (live[h] && live[h].related) || [], menus: menuPlaces[h] || [] });
}

fs.writeFileSync(path.join(ROOT, 'audit', 'structure.json'), JSON.stringify(out, null, 1));
const withNested = out.filter((o) => o.children.length).length;
const withRelated = out.filter((o) => o.related.length >= 4).length;
const shortRelated = out.filter((o) => !o.hidden && o.related.length < 4).map((o) => `${o.handle}(${o.related.length})`);
console.log({ collections: out.length, withNested, withRelated, shortRelated, errors });
