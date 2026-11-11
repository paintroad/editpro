// Read-only catalog audit. Applies rulebook.js to the snapshot and writes the proposed mapping.
// Usage: node audit.js            (reads data/, writes audit/)
// Overrides from the review loop are read from audit/overrides.json if present.
const fs = require('fs');
const path = require('path');
const rb = require('./rulebook');

const ROOT = path.join(process.env.USERPROFILE, 'Downloads', '_Catalog', 'Catalog Audit');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'audit');
fs.mkdirSync(OUT, { recursive: true });

const products = JSON.parse(fs.readFileSync(path.join(DATA, 'products.json'), 'utf8'));
const collections = JSON.parse(fs.readFileSync(path.join(DATA, 'collections.json'), 'utf8'));
const visualFile = path.join(OUT, 'visual.json');
const visual = fs.existsSync(visualFile) ? JSON.parse(fs.readFileSync(visualFile, 'utf8')) : {};
const overridesFile = path.join(OUT, 'overrides.json');
const overrides = fs.existsSync(overridesFile) ? JSON.parse(fs.readFileSync(overridesFile, 'utf8')) : { products: {}, rules: {} };

const re = (s) => new RegExp(s, 'i');
const colByHandle = Object.fromEntries(collections.map((c) => [c.handle, c]));
const titleOf = (h) => (colByHandle[h] && colByHandle[h].title) || (rb.newCollections.find((n) => n.handle === h) || {}).title || h;

function ruleTags(c) {
  if (!c || !c.ruleSet) return [];
  return c.ruleSet.rules.filter((r) => r.column === 'TAG' && r.relation === 'EQUALS').map((r) => r.condition);
}
const tagIndex = {}; // lowercased tag -> collection handles whose rule uses it
for (const c of collections) {
  if (!c.ruleSet || !c.ruleSet.appliedDisjunctively) continue;
  for (const t of ruleTags(c)) (tagIndex[t.toLowerCase()] = tagIndex[t.toLowerCase()] || []).push(c.handle);
}

const deityKeys = { 'lord-krishna': 'krishna', 'radha-kishan': 'krishna', 'shrinathji-paintings': 'krishna', 'krishna-leela-paintings': 'krishna',
  'lord-shiva': 'shiva', 'shiva-purana-paintings': 'shiva', 'lord-ganesha': 'ganesha', 'lord-hanuman': 'hanuman', 'lord-vishnu': 'vishnu',
  'lord-buddha': 'buddha', 'goddess-art': 'goddess', 'goddess-durga': 'goddess', 'goddess-lakshmi': 'goddess', 'devi-mahatmya-paintings': 'goddess', 'ramayana-paintings': 'rama' };
const deityNames = { krishna: 'Krishna', shiva: 'Shiva', ganesha: 'Ganesha', hanuman: 'Hanuman', vishnu: 'Vishnu', buddha: 'Buddha', goddess: 'a goddess', rama: 'Rama' };

// Removals in these need an image check: secondary motifs and art styles are often missing from the text.
const VISUAL_FAMILIES = new Set(['Indian motifs', 'Indian & devotional']);
const VISUAL_COLLECTIONS = new Set(['abstract', 'autumn', 'greek', 'kamdhenu-and-cow-paintings', 'bird-paintings', 'floral-art', 'botanical-prints',
  'horse-paintings', 'animal', 'dog-lovers', 'cat-lovers', 'women-illustrations', 'motivational-quotes']);

const merges = { 'maximalist-art': 'maximalist', 'picasso-style': 'picasso-inspired', 'baby-room': 'kids-nursery', 'kids-room': 'kids-nursery' };
const notAudited = new Set(rb.NOT_AUDITED);
const lowerTags = (p) => new Set(p.tags.map((t) => t.toLowerCase()));

function auditProduct(p) {
  const before = p.collections.slice();
  const after = new Set(before);
  const changes = [];
  const title = p.title || '';
  const text = `${title} ${p.desc || ''}`;
  const ltags = lowerTags(p);
  const has = (h) => after.has(h);
  const add = (h, rule, reason, confidence) => { if (after.has(h)) return; after.add(h); changes.push({ action: 'add', collection: h, rule, reason, confidence }); };
  const vis = visual[p.id] || { keep: [], confirm: [], add: [] };
  const notes = [];
  const remove = (h, rule, reason, confidence) => {
    if (!after.has(h)) return;
    if (confidence === 'low' && vis.keep.includes(h)) { notes.push(`Kept in ${titleOf(h)} after image check (${rule}: ${reason})`); return; }
    if (confidence === 'low' && vis.confirm.includes(h)) { confidence = 'medium'; reason += ' (image checked)'; }
    after.delete(h); changes.push({ action: 'remove', collection: h, rule, reason, confidence });
  };

  const indianHits = before.filter((h) => rb.INDIAN.includes(h));
  const indianTag = rb.INDIAN_TAGS.some((t) => ltags.has(t.toLowerCase()));
  const buddhaOnly = before.includes('lord-buddha') && indianHits.every((h) => h === 'devotional');
  const indian = !buddhaOnly && (indianHits.length > 0 || indianTag);
  const inspired = before.some((h) => rb.INSPIRED.includes(h));
  const master = !inspired && before.some((h) => rb.MASTERS.includes(h) || h === 'famous-artists');
  const kids = before.some((h) => ['kids-nursery', 'baby-room', 'kids-room'].includes(h));

  // R9 merges
  for (const [from, to] of Object.entries(merges)) {
    if (has(from)) { add(to, 'R9', `${titleOf(from)} is merged into ${titleOf(to)}`, 'high'); remove(from, 'R9', `Merged into ${titleOf(to)}`, 'high'); }
  }
  if (has('indian-art-wall-paintings')) {
    if (indian) add('indian-art', 'R9', 'Indian Art Wall Paintings is merged into Indian Art', 'high');
    else add('travel', 'R9', 'Tagged "indian" for the place, not the art form', 'medium');
    remove('indian-art-wall-paintings', 'R9', 'Merged into Indian Art', 'high');
  }

  // R6 obvious missing collections (title only)
  for (const [h, def] of Object.entries(rb.collections)) {
    if (!def.add || has(h)) continue;
    if (!re(def.add).test(title)) continue;
    if (def.indianOnly && !indian) continue;
    if (def.deity && !indian && h !== 'lord-buddha') continue;
    if (master && def.deity && !indian) continue;
    add(h, 'R6', `Title mentions "${title.match(re(def.add))[0]}"`, 'high');
  }

  // R1 / R2
  if (has('abstract') && has('boho')) remove('abstract', 'R1', 'Boho product; shoppers find it in Boho', 'high');
  const named = rb.NAMED_STYLES.filter((h) => h !== 'boho' && has(h));
  if (has('abstract') && named.length) remove('abstract', 'R2', `Already in ${named.map(titleOf).join(', ')}`, 'medium');

  // R3 / R4
  if (indian) for (const h of rb.CONTEMPORARY_STYLES) remove(h, 'R3', 'Indian / devotional art; belongs in Indian Art, not contemporary style pages', 'high');
  if (master) {
    const modernText = /abstract|contemporary|modern|geometric|minimalis/i.test(text);
    for (const h of rb.CONTEMPORARY_STYLES) remove(h, 'R4', modernText ? 'In a famous-painter collection but described as abstract/modern; check the image' : 'Famous painter\'s work; belongs in Famous Painters', modernText ? 'low' : 'high');
  }

  // Abstract rule change
  if (has('abstract') && !ltags.has('abstract')) {
    const via = p.tags.filter((t) => ['random', 'brush strokes'].includes(t.toLowerCase()));
    remove('abstract', 'R5', `Only in Abstract via tag ${via.map((t) => `"${t}"`).join(', ') || 'rule'}; rule now uses "abstract" only`, re(rb.KW.abstract).test(text) ? 'low' : 'high');
  }

  // R5 confirmation
  for (const h of [...after]) {
    const def = rb.collections[h];
    if (!def || !def.confirm || notAudited.has(h)) continue;
    if (re(def.confirm).test(text)) continue;
    let confidence = def.conf || 'medium';
    let reason = `Title and description never mention ${def.family === 'Devotional' ? 'this deity' : 'the subject'}`;
    if (deityKeys[h]) {
      const other = Object.entries({ ...rb.KW, vishnu: 'vishnu|narayan|venkateshwara|balaji|padmanabh|sheshnag' })
        .find(([k, v]) => deityNames[k] && k !== deityKeys[h] && !(k === 'vishnu' && ['krishna', 'rama'].includes(deityKeys[h])) && re(v).test(text));
      if (h === 'radha-kishan' && re(rb.KW.krishna).test(text)) { confidence = 'medium'; reason = 'Krishna without Radha (gopis or devotees); belongs in Krishna / Krishna Leela'; }
      else if (other) { confidence = 'high'; reason = `Text is about ${deityNames[other[0]]}, not ${titleOf(h)}`; }
      else confidence = 'low';
    }
    if (VISUAL_FAMILIES.has(def.family) || VISUAL_COLLECTIONS.has(h)) confidence = 'low';
    if (!p.desc) confidence = 'low';
    remove(h, 'R5', reason, confidence);
  }

  // R7
  if (has('bathroom') && [...after].some((h) => rb.DEVOTIONAL.includes(h))) remove('bathroom', 'R7', 'Devotional art is not sold for bathrooms', 'high');

  // R8 new collections
  for (const n of rb.newCollections) {
    if (n.indianOnly && !indian) continue;
    if (n.notIndian && indian) continue;
    if (n.parent === 'modern' && master) continue;
    if (n.requireIn && !n.requireIn.every((h) => has(h))) continue;
    if (n.requireAnyIn && !n.requireAnyIn.some((h) => has(h))) continue;
    if (n.handle === 'cityscapes' && has('banksy')) continue;
    if (n.handle === 'wildlife' && kids) continue;
    let m = null;
    if (n.matchTag) m = p.tags.includes(n.matchTag) ? [n.matchTag] : null;
    else m = (n.scope === 'title' ? title : text).match(re(n.match));
    if (m) add(n.handle, 'R8', n.matchTag ? `Has tag "${n.matchTag}"` : `${n.scope === 'title' ? 'Title' : 'Text'} mentions "${m[0]}"`, n.scope === 'title' || n.matchTag ? 'high' : 'medium');
  }

  for (const h of vis.add) add(h, 'Visual', 'Spotted in image check', 'high');

  // Overrides from review: keep / force
  const ov = overrides.products[p.id];
  if (ov) {
    for (const h of ov.keep || []) { if (before.includes(h) && !after.has(h)) { after.add(h); const i = changes.findIndex((c) => c.collection === h && c.action === 'remove'); if (i >= 0) changes.splice(i, 1); } }
    for (const h of ov.drop || []) { if (after.has(h) && !before.includes(h)) { after.delete(h); const i = changes.findIndex((c) => c.collection === h && c.action === 'add'); if (i >= 0) changes.splice(i, 1); } }
    for (const h of ov.add || []) add(h, 'Review', 'Added in review', 'high');
    for (const h of ov.remove || []) remove(h, 'Review', 'Removed in review', 'high');
  }

  const family = indian ? 'Indian & devotional' : master ? 'Famous painters' : inspired ? 'Famous painters (inspired)'
    : has('boho') || before.includes('boho') ? 'Boho' : named.length ? titleOf(named[0]) : before.includes('abstract') ? 'Abstract' : before.includes('modern') ? 'Contemporary' : 'Other';

  return { id: p.id, handle: p.handle, title, image: p.image, url: `https://paintroad.com/products/${p.handle}`, createdAt: p.createdAt,
    desc: (p.desc || '').slice(0, 300), tags: p.tags, family, before, after: [...after], changes, notes,
    needsVisual: changes.some((c) => c.confidence === 'low') };
}

const roomRes = rb.rooms.map((r) => ({ ...r, re: new RegExp(r.keywords, 'gi') }));
function bestRoom(r, p) {
  const inColl = new Set([...r.after, ...r.before.filter((h) => ['kids-nursery', 'baby-room', 'kids-room'].includes(h))]);
  const devotional = [...inColl].some((h) => rb.DEVOTIONAL.includes(h));
  const scores = roomRes.map((room) => {
    const why = [];
    let s = 0;
    for (const [h, w] of Object.entries(room.collections)) if (inColl.has(h)) { s += w; why.push(titleOf(h)); }
    const t = (p.title.match(room.re) || []).map((x) => x.toLowerCase());
    const d = ((p.desc || '').match(room.re) || []).map((x) => x.toLowerCase());
    s += Math.min(t.length * 2 + d.length, 6);
    const words = [...new Set([...t, ...d])].slice(0, 3);
    if (words.length) why.push(`"${words.join('", "')}"`);
    if (devotional && ['bathroom', 'kitchen', 'kids-nursery'].includes(room.handle)) s = -1;
    return { room: room.handle, title: room.title, score: s, why };
  }).sort((a, b) => b.score - a.score);
  const top = scores[0], second = scores[1];
  if (top.score <= 0) return { room: 'living-room', title: 'Living Room', confidence: 'low', reason: 'No room signal; Living Room by default', alternatives: [] };
  const confidence = top.score >= 5 && top.score - second.score >= 2 ? 'high' : top.score >= 3 ? 'medium' : 'low';
  return { room: top.room, title: top.title, confidence, reason: top.why.join(', '),
    alternatives: scores.slice(1, 3).filter((x) => x.score > 0).map((x) => ({ room: x.room, title: x.title, score: x.score })) };
}

let results = products.map(auditProduct);
const roomTitle = Object.fromEntries(rb.rooms.map((x) => [x.handle, x.title]));
results.forEach((r, i) => {
  r.room = bestRoom(r, products[i]);
  const ov = overrides.products[r.id];
  if (ov && ov.room && ov.room !== r.room.room) r.room = { room: ov.room, title: roomTitle[ov.room], confidence: 'high', reason: `Chosen in review (rules said ${r.room.title})`, alternatives: [] };
});

// Drop new collections below threshold
const newCounts = {};
for (const r of results) for (const c of r.changes) if (c.rule === 'R8') newCounts[c.collection] = (newCounts[c.collection] || 0) + 1;
const tooSmall = rb.newCollections.filter((n) => (newCounts[n.handle] || 0) < 8).map((n) => n.handle);
for (const r of results) {
  r.changes = r.changes.filter((c) => !(c.rule === 'R8' && tooSmall.includes(c.collection)));
  r.after = r.after.filter((h) => !tooSmall.includes(h));
}

// Tag operations needed to realise the change (for the later apply plan)
for (const r of results) {
  const ops = [];
  for (const c of r.changes) {
    if (c.action === 'add') {
      const n = rb.newCollections.find((x) => x.handle === c.collection);
      const tag = n ? n.tag : ruleTags(colByHandle[c.collection])[0];
      if (tag) ops.push({ op: 'add', tag, for: c.collection });
    } else {
      const ruleSet = new Set(ruleTags(colByHandle[c.collection]).map((t) => t.toLowerCase()));
      const tags = r.tags.filter((t) => ruleSet.has(t.toLowerCase()));
      const sideEffects = [...new Set(tags.flatMap((t) => tagIndex[t.toLowerCase()] || []))].filter((h) => h !== c.collection && r.after.includes(h));
      ops.push({ op: 'remove', tags, for: c.collection, sideEffects });
    }
  }
  r.tagOps = ops;
}

// Collection summary
const allHandles = [...collections.map((c) => c.handle), ...rb.newCollections.map((n) => n.handle).filter((h) => !tooSmall.includes(h))];
const summary = allHandles.map((h) => {
  const before = results.filter((r) => r.before.includes(h)).length;
  const after = results.filter((r) => r.after.includes(h)).length;
  const removed = results.filter((r) => r.changes.some((c) => c.collection === h && c.action === 'remove')).length;
  const added = results.filter((r) => r.changes.some((c) => c.collection === h && c.action === 'add')).length;
  const n = rb.newCollections.find((x) => x.handle === h);
  const def = rb.collections[h] || {};
  return { handle: h, title: titleOf(h), family: n ? 'New' : def.family || (notAudited.has(h) ? 'Room / system' : ''), promise: n ? n.promise : def.promise || '',
    isNew: !!n, before, after, added, removed, audited: !notAudited.has(h) };
});

const stats = {
  generatedAt: new Date().toISOString(),
  products: results.length,
  changed: results.filter((r) => r.changes.length).length,
  removals: results.reduce((a, r) => a + r.changes.filter((c) => c.action === 'remove').length, 0),
  additions: results.reduce((a, r) => a + r.changes.filter((c) => c.action === 'add').length, 0),
  needsVisual: results.filter((r) => r.needsVisual).length,
  byRule: {}, byConfidence: {}, newCounts, tooSmall,
};
stats.rooms = {};
for (const r of results) { const k = r.room.room; stats.rooms[k] = stats.rooms[k] || { high: 0, medium: 0, low: 0 }; stats.rooms[k][r.room.confidence]++; }
for (const r of results) for (const c of r.changes) { stats.byRule[c.rule] = (stats.byRule[c.rule] || 0) + 1; stats.byConfidence[c.confidence] = (stats.byConfidence[c.confidence] || 0) + 1; }

fs.writeFileSync(path.join(OUT, 'proposal.json'), JSON.stringify(results));
fs.writeFileSync(path.join(OUT, 'collections-summary.json'), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(stats, null, 1));
console.log(JSON.stringify(stats, null, 1));
