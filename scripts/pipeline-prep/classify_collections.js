/**
 * Label every prep painting with collection tags from COLLECTION_TAGS (lib/catalog-collections.js).
 * Results go to catalog.db images.collection_tags; rows that already have labels are skipped.
 *
 *   node scripts/pipeline-prep/classify_collections.js [--redo] [--limit N] [NAME...]
 */
const fs = require("fs");
const { openAiImageBuffer } = require("../../lib/openai-image");
const { DatabaseSync } = require("node:sqlite");
const { getOpenAiApiKey } = require("../../lib/config-store");
const { COLLECTION_TAGS } = require("../../lib/catalog-collections");
const reference = require("../../lib/catalog-reference");
const { runPool } = require("../../lib/parallel-pool");

const args = process.argv.slice(2);
const redo = args.includes("--redo");
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
const names = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--limit");

function prompt(context) {
  const lines = COLLECTION_TAGS.map((row) => `- "${row.tag}": ${row.hint}`).join("\n");
  return (
    "You label art prints (Indian traditional and contemporary) for an online store's collections. Look at the artwork and return JSON " +
    '{"tags": [...]} using only exact strings from this list. Pick every tag that clearly applies: ' +
    "at most two art-form tags, any number of subject and motif tags. A motif tag needs the motif to be a main subject, not a small detail. " +
    "Leave a tag out when unsure.\n\n" +
    lines +
    (context ? `\n\nKnown about this artwork: ${context}` : "")
  );
}

async function classify(row, apiKey) {
  const image = await openAiImageBuffer(row.file, { maxWidth: 512 });
  const ref = await reference.referenceForRow(row);
  const context = [
    ref.categories.length ? `filed under ${ref.categories.join(" > ")}` : "",
    ref.folder ? `from the ${ref.folder} set` : "",
    ref.match ? `listed elsewhere as "${ref.match.title}"` : "",
  ]
    .filter(Boolean)
    .join("; ");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt(context) },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}`, detail: "low" } },
            ],
          },
        ],
      }),
    });
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = await response.json();
    const tags = JSON.parse(data.choices[0].message.content).tags || [];
    const allowed = new Set(COLLECTION_TAGS.map((entry) => entry.tag));
    return [...new Set(tags.filter((tag) => allowed.has(tag)))];
  }
  throw new Error("OpenAI kept rate limiting");
}

(async () => {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) throw new Error("OpenAI API key is not configured.");
  reference.prepRow("init");
  const db = new DatabaseSync(reference.DB_PATH);
  db.exec("PRAGMA busy_timeout = 10000;");
  const columns = new Set(db.prepare("PRAGMA table_info(images)").all().map((column) => column.name));
  if (!columns.has("collection_tags")) db.exec("ALTER TABLE images ADD COLUMN collection_tags TEXT");

  let rows = db.prepare("SELECT * FROM images WHERE file IS NOT NULL ORDER BY name").all();
  if (names.length) rows = rows.filter((row) => names.includes(row.name));
  if (!redo) rows = rows.filter((row) => !row.collection_tags);
  rows = rows.filter((row) => fs.existsSync(row.file)).slice(0, limit);
  console.log(`Labelling ${rows.length} paintings`);

  const save = db.prepare("UPDATE images SET collection_tags = ? WHERE name = ?");
  let done = 0;
  let failed = 0;
  let next = 0;
  await runPool({
    concurrency: 6,
    claimIndex: () => (next < rows.length ? next++ : -1),
    onIndex: async (index) => {
      const row = rows[index];
      try {
        const tags = await classify(row, apiKey);
        save.run(JSON.stringify(tags), row.name);
        done += 1;
        if (done % 25 === 0 || names.length) console.log(`${done}/${rows.length} ${row.name}: ${tags.join(", ")}`);
      } catch (error) {
        failed += 1;
        console.log(`FAILED ${row.name}: ${error.message}`);
      }
    },
  });
  console.log(`Done: ${done} labelled, ${failed} failed`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
