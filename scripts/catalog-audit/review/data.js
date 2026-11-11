// Data and feedback for the catalog review page. Used by serve.js (standalone) and EditPro (lib/review-routes.js).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.env.USERPROFILE, 'Downloads', '_Catalog', 'Catalog Audit');
const A = path.join(ROOT, 'audit');
const FB = path.join(ROOT, 'review', 'feedback.json');
const PAGE = path.join(__dirname, 'index.html');
const SCRIPT = path.join(__dirname, 'app.js');

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function data() {
  const changelog = read(path.join(A, 'changelog.json'));
  const proposal = read(path.join(A, 'proposal.json'));
  return {
    generatedAt: changelog.generatedAt, stats: changelog.stats, principles: changelog.principles, rules: changelog.rules,
    collectionChanges: changelog.collectionChanges, newCollections: changelog.newCollections, collections: changelog.collections, rooms: changelog.rooms,
    products: proposal.map((r) => ({ id: r.id, handle: r.handle, title: r.title, image: r.image, url: r.url, family: r.family, desc: r.desc,
      before: r.before, after: r.after, changes: r.changes, notes: r.notes || [], room: r.room })),
  };
}

const readFeedback = () => (fs.existsSync(FB) ? fs.readFileSync(FB, 'utf8') : '{"products":{},"collections":{}}');

function saveFeedback(j) {
  if (!j || typeof j !== 'object' || typeof j.products !== 'object') throw new Error('Feedback must have a products object.');
  j.savedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(FB), { recursive: true });
  fs.writeFileSync(FB, JSON.stringify(j, null, 1));
}

module.exports = { FB, PAGE, SCRIPT, data, readFeedback, saveFeedback };
