// Re-runs the audit pipeline after rule edits or applied feedback: audit -> hierarchy -> changelog.
// Does not touch Shopify. Refresh the review UI afterwards; existing feedback is kept.
const { execFileSync } = require('child_process');
const path = require('path');

for (const step of ['audit.js', 'hierarchy.js', 'changelog.js']) {
  console.log(`\n== ${step}`);
  execFileSync(process.execPath, [path.join(__dirname, step)], { stdio: 'inherit' });
}
