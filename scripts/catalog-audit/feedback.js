// Reads review/feedback.json and summarises flags by rule and collection.
// --apply writes "Disagree" clicks into audit/overrides.json (keep a removed collection / drop an added one), then run regenerate.js.
// Free-text comments are listed for rule fixes; they are never applied automatically.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.env.USERPROFILE, 'Downloads', '_Catalog', 'Catalog Audit');
const fbFile = path.join(ROOT, 'review', 'feedback.json');
const ovFile = path.join(ROOT, 'audit', 'overrides.json');
if (!fs.existsSync(fbFile)) { console.log('No feedback yet:', fbFile); process.exit(0); }

const fb = JSON.parse(fs.readFileSync(fbFile, 'utf8'));
const proposal = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit', 'proposal.json'), 'utf8'));
const byId = Object.fromEntries(proposal.map((p) => [p.id, p]));
const ov = fs.existsSync(ovFile) ? JSON.parse(fs.readFileSync(ovFile, 'utf8')) : { products: {}, rules: {} };

const entries = Object.entries(fb.products || {});
const flagged = entries.filter(([, v]) => v.status === 'flagged');
const approved = entries.filter(([, v]) => v.status === 'approved');
const byRule = {}, byCollection = {};
const comments = [];
let disagreements = 0;

for (const [id, v] of flagged) {
  const p = byId[id];
  if (!p) continue;
  for (const key of v.disagree || []) {
    const [collection, action] = key.split(':');
    const c = p.changes.find((x) => x.collection === collection && x.action === action);
    const rule = c ? c.rule : '?';
    disagreements++;
    byRule[rule] = (byRule[rule] || 0) + 1;
    byCollection[`${action} ${collection}`] = (byCollection[`${action} ${collection}`] || 0) + 1;
    const o = (ov.products[id] = ov.products[id] || {});
    const list = action === 'remove' ? (o.keep = o.keep || []) : (o.drop = o.drop || []);
    if (!list.includes(collection)) list.push(collection);
  }
  if (v.comment) comments.push({ id, title: p.title, comment: v.comment, changes: p.changes.map((c) => `${c.action} ${c.collection} (${c.rule})`) });
}

const roomChanges = {};
for (const [id, v] of entries) {
  if (!v.room || !byId[id]) continue;
  const key = `${byId[id].room.room} -> ${v.room}`;
  roomChanges[key] = (roomChanges[key] || 0) + 1;
  (ov.products[id] = ov.products[id] || {}).room = v.room;
}

const summary = {
  roomChanges: Object.fromEntries(Object.entries(roomChanges).sort((a, b) => b[1] - a[1])),
  reviewed: entries.length, approved: approved.length, flagged: flagged.length, disagreements,
  byRule, byCollection: Object.fromEntries(Object.entries(byCollection).sort((a, b) => b[1] - a[1])),
  comments, collectionNotes: fb.collections || {},
};
fs.writeFileSync(path.join(ROOT, 'review', 'feedback-summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, comments: comments.length, collectionNotes: Object.keys(summary.collectionNotes).length }, null, 1));

if (process.argv.includes('--apply')) {
  fs.writeFileSync(ovFile, JSON.stringify(ov, null, 1));
  console.log(`Wrote ${Object.keys(ov.products).length} product overrides to ${ovFile}. Now run: node regenerate.js`);
}
