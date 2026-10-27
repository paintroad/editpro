/**
 * Replace each product's Shopify index image with the exported transparent PNG.
 * Lifestyle images are left alone. Products already marked uploaded are skipped.
 *
 * Usage: node scripts/upload-all-index-cutouts.js [jobs.json]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getShopifyCredentials } = require("../lib/config-store");
const { uploadCutouts } = require("../lib/index-cutout");

const jobsPath =
  process.argv[2] || path.join(os.tmpdir(), "index-cutout-all-jobs.json");
const logPath = path.join(os.tmpdir(), "index-cutout-upload.log");
const logStream = fs.createWriteStream(logPath, { flags: "w" });
const writeLine = console.log;
const writeError = console.error;
function writeLog(writer, args) {
  logStream.write(`${args.join(" ")}\n`);
  writer.apply(console, args);
}
console.log = (...args) => writeLog(writeLine, args);
console.error = (...args) => writeLog(writeError, args);

async function main() {
  const jobs = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
  const ids = jobs.map((job) => String(job.productId));
  const creds = getShopifyCredentials();
  console.log(`replacing ${ids.length} index images on ${creds.storeDomain}`);
  const { results } = await uploadCutouts(creds.storeDomain, creds.accessToken, ids);
  const counts = { uploaded: 0, skipped: 0, error: 0 };
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  console.log(`done uploaded=${counts.uploaded} skipped=${counts.skipped} error=${counts.error}`);
  if (counts.error) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
