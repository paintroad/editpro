/**
 * Build the collections handover (Excel + brief) from catalog.db collection tags.
 * Re-run after the Pipeline puts products live to fill product numbers, titles and live status.
 *
 *   node scripts/pipeline-prep/collections_handover.js [outDir]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const XLSX = require("xlsx");
const { DatabaseSync } = require("node:sqlite");
const { COLLECTION_TAGS, PARENT_TAGS, collectionTagsFrom, withParents } = require("../../lib/catalog-collections");
const reference = require("../../lib/catalog-reference");
const { loadCatalogStore } = require("../../lib/catalog-products-store");
const { loadConfig } = require("../../lib/config-store");
const { shopifyGraphql } = require("../../lib/shopify-client");
const { assertClean } = require("../../lib/brand-guard");

const OUT_DIR = process.argv[2] || path.join(os.homedir(), "Downloads");
const MIN_NEW = 12;
const MENU = { "Art form": "Indian Art > Art Forms", Subject: "Indian Art > Gods & Stories", Motif: "Indian Art > Motifs", Use: "Indian Art > Vastu", Contemporary: "Styles" };

/** Storefront title, handle and one-line description per tag. Existing collections keep their live title. */
const PAGES = {
  Pichwai: ["Pichwai Paintings", "Temple art from Nathdwara: Shrinathji, sacred cows, lotus ponds and gopis in rich detail."],
  Gond: ["Gond Art", "Tribal art from central India, with animals, birds and trees built from dots and fine lines."],
  Madhubani: ["Madhubani Paintings", "Mithila art from Bihar: bold outlines and every space filled with pattern."],
  "Warli Art": ["Warli Art", "Tribal art from Maharashtra: stick figures, circles and village life in white on earth tones."],
  Pattachitra: ["Pattachitra", "Odisha and Bengal scroll paintings with ornate borders and stylised gods and epics."],
  Kalighat: ["Kalighat Paintings", "Bold, fluid brushwork from 19th-century Calcutta: gods, goddesses and city life."],
  Kalamkari: ["Kalamkari Art", "Hand-drawn textile-style art in muted reds, ochres and black."],
  Phad: ["Phad Paintings", "Rajasthani scroll paintings that tell epics in bright flat panels."],
  Tanjore: ["Tanjore Paintings", "South Indian devotional art: rich colours, gold and deities framed in arches."],
  "Mughal Art": ["Mughal Art", "Miniatures from the Mughal court: emperors, hunts, gardens and floral studies."],
  "Indian Miniature": ["Indian Miniature Paintings", "Rajput, Pahari and Deccan miniatures: courtly life, legends and love in fine detail."],
  Ragamala: ["Ragamala Paintings", "Miniatures that turn musical ragas into scenes of love, longing and the seasons."],
  Thangka: ["Thangka Art", "Tibetan Buddhist art: Buddhas, mandalas and deities in sacred geometry."],
  "Raja Ravi Verma": ["Raja Ravi Verma", "Oil paintings by Raja Ravi Varma: gods, goddesses and heroines from Indian epics."],
  "Vintage Indian Art": ["Vintage Indian Art", "Antique Indian paintings and prints, restored for today's walls."],
  Shrinathji: ["Shrinathji Paintings", "Shrinathji of Nathdwara, Krishna with his raised arm, in Pichwai tradition."],
  "Lord Krishna": ["Lord Krishna", "Krishna as child, cowherd, lover and lord."],
  Radha: ["Radha Krishna", "The divine love of Radha and Krishna."],
  "Lord Ganesha": ["Lord Ganesha", "Ganesha, remover of obstacles, for new beginnings."],
  "Lord Shiva": ["Lord Shiva", "Shiva, Parvati and Nataraja."],
  "Lord Hanuman": ["Lord Hanuman", "Hanuman, symbol of strength and devotion."],
  Ramayana: ["Ramayana Paintings", "Rama, Sita, Lakshmana and Hanuman: scenes from the Ramayana."],
  "Hindu Goddess": ["Goddess Art", "Durga, Kali, Lakshmi, Saraswati and Parvati."],
  Lakshmi: ["Goddess Lakshmi", "Lakshmi, goddess of wealth and prosperity."],
  Durga: ["Goddess Durga", "Durga, the warrior goddess, and her victory over Mahishasura."],
  Kali: ["Goddess Kali", "Kali, the fierce mother goddess."],
  Saraswati: ["Goddess Saraswati", "Saraswati, goddess of knowledge, music and the arts."],
  "Lord Vishnu": ["Lord Vishnu", "Vishnu, Narayana, Balaji and Jagannath."],
  "Lord Buddha": ["Lord Buddha", "Calm Buddha art for meditation and living spaces."],
  "Music and Dance": ["Music & Dance", "Musicians and dancers from Indian art traditions."],
  Lotus: ["Lotus Paintings", "Lotus flowers and ponds, a symbol of purity and calm."],
  "Tree of Life": ["Tree of Life", "The tree of life and kalpavriksha across Indian art forms."],
  Peacock: ["Peacock Paintings", "Peacocks in Indian art, symbols of beauty and grace."],
  Elephant: ["Elephant Paintings", "Elephants in Indian art, symbols of strength and good fortune."],
  Cows: ["Kamdhenu & Cow Paintings", "Kamdhenu and sacred cows, symbols of abundance."],
  Horses: ["Horse Paintings", "Horses in Indian art, including Vastu-favoured running horses."],
  Birds: ["Bird Paintings", "Birds from Indian and contemporary art."],
  Flowers: ["Floral Art", "Flowers and floral studies from Indian and contemporary art."],
  Fish: ["Fish Paintings", "Fish in Indian art, a symbol of prosperity."],
  Mandala: ["Mandala Art", "Mandalas and sacred geometry."],
  Vastu: ["Vastu Paintings", "Art chosen for Vastu: running horses, Kamdhenu, elephants, lotus, the tree of life and the rising sun."],
  Boho: ["Boho", "Earthy boho prints: arches, vases, suns and soft shapes."],
  Animal: ["Animal", "Animal art, from patchwork giraffes to big cats."],
  Travel: ["Travel", "Towns, trains, ships and far-off places."],
  Mediterranean: ["Mediterranean & Moroccan", "Moroccan doors, arches, tiles and sunlit villages."],
};

function slug(text) {
  return String(text).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function liveCollections() {
  const { storeDomain, accessToken } = loadConfig().shopify;
  const out = [];
  let after = null;
  do {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query($a: String) { collections(first: 250, after: $a) { pageInfo { hasNextPage endCursor }
        nodes { title handle productsCount { count } ruleSet { rules { column condition } } } } }`,
      { a: after }
    );
    out.push(...data.collections.nodes);
    after = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (after);
  return out;
}

(async () => {
  reference.prepRow("init");
  const db = new DatabaseSync(reference.DB_PATH);
  const rows = db.prepare("SELECT * FROM images ORDER BY name").all();
  const store = loadCatalogStore();
  const live = await liveCollections();
  const byTag = new Map();
  const fewestRulesFirst = [...live].sort((a, b) => (a.ruleSet?.rules.length || 99) - (b.ruleSet?.rules.length || 99));
  for (const collection of fewestRulesFirst) {
    for (const rule of collection.ruleSet?.rules || []) {
      const dedicated = collection.ruleSet.rules.length <= 2 || collection.title.toLowerCase().includes(rule.condition.toLowerCase());
      if (rule.column === "TAG" && dedicated && !byTag.has(rule.condition.toLowerCase())) byTag.set(rule.condition.toLowerCase(), collection);
    }
  }

  const paintings = rows.map((row) => {
    const tags = withParents([...reference.styleTagsFor(row), ...collectionTagsFrom(row.collection_tags)]);
    const product = row.product_id ? store.products[row.product_id] : null;
    return { row, tags, product };
  });
  const counts = {};
  for (const item of paintings) for (const tag of item.tags) counts[tag] = (counts[tag] || 0) + 1;

  const collectionRows = [["Status", "Collection title", "Handle", "Smart rule", "Menu group", "Paintings in new catalog", "Live products now", "Also feeds", "Description"]];
  const plan = [];
  for (const entry of COLLECTION_TAGS) {
    const existing = byTag.get(entry.tag.toLowerCase());
    const count = counts[entry.tag] || 0;
    const [title, description] = PAGES[entry.tag] || [entry.tag, ""];
    const status = existing ? "Existing - grows" : count >= MIN_NEW ? "Create" : "Hold (tag only, under 12)";
    const item = {
      status,
      title: existing ? existing.title : title,
      handle: existing ? existing.handle : slug(title),
      rule: `Product tag is equal to "${entry.tag}"`,
      menu: MENU[entry.group],
      count,
      liveNow: existing ? existing.productsCount.count : 0,
      parents: (PARENT_TAGS[entry.tag] || []).join(", "),
      description,
    };
    plan.push(item);
  }
  const order = { Create: 0, "Existing - grows": 1, "Hold (tag only, under 12)": 2 };
  plan.sort((a, b) => order[a.status] - order[b.status] || b.count - a.count);
  for (const item of plan) {
    collectionRows.push([item.status, item.title, item.handle, item.rule, item.menu, item.count, item.liveNow, item.parents, item.description]);
  }

  const paintingRows = [["Product number", "Product title", "Handle", "Live on Shopify", "Collection tags"]];
  for (const item of paintings) {
    paintingRows.push([
      item.row.product_id || "(numbered at upload)",
      item.product?.title || "",
      item.product?.handle || "",
      item.product?.shopifyStatus === "created" ? "Yes" : "No",
      item.tags.join(", "),
    ]);
  }

  const notes = [
    ["Notes for the site agent"],
    ["Tags are added to each product automatically when the EditPro Pipeline publishes it. Smart collections only need the tag rule shown."],
    ["Create collections after the upload finishes so they launch full. Re-run this export then to get product numbers and titles."],
    ["The live Madhubani collection also matches the tag \"Indian Botanical Art\". The new catalog no longer uses that tag; consider removing that condition so botanical prints stop appearing under Madhubani."],
    ["The live Pichwai collection has 3 products and Gond has 4; both grow substantially with this catalog."],
    ["Hold rows: keep the tag, create the collection once 12 or more products carry it."],
    ["God paintings carry their own god tag (Lord Ganesha, Lord Krishna, Lakshmi, Durga, ...) plus Devotional, and goddesses also carry Hindu Goddess. They are never tagged Vastu."],
    ["Lakshmi already feeds the Devotional collection; a dedicated Goddess Lakshmi collection can follow once it reaches 12 products."],
    ["Never mention competitor brands anywhere on the site."],
  ];

  assertClean({ collectionRows, paintingRows, notes }, "collections handover");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(collectionRows), "Collections");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(paintingRows), "Paintings");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(notes), "Notes");
  const xlsxPath = path.join(OUT_DIR, "Paint Road - New Collections.xlsx");
  XLSX.writeFile(workbook, xlsxPath);

  const create = plan.filter((item) => item.status === "Create");
  const grow = plan.filter((item) => item.status === "Existing - grows");
  const hold = plan.filter((item) => item.status.startsWith("Hold"));
  const line = (item) => `| ${item.title} | \`${item.handle}\` | ${item.rule.replace("Product tag is equal to ", "tag = ")} | ${item.menu} | ${item.count} |`;
  const brief = [
    "# Paint Road: new collections for the Indian art catalog",
    "",
    `Generated ${new Date().toISOString().slice(0, 10)} from the EditPro Pipeline catalog (${rows.length} paintings). Full detail, descriptions and per-product tags are in \`Paint Road - New Collections.xlsx\`.`,
    "",
    "Every product published by the Pipeline already carries these tags, so each collection is a smart collection with one rule: product tag equals the tag shown.",
    "Create them after the upload finishes. Never mention competitor brands anywhere on the site.",
    "",
    `## Create (${create.length})`,
    "",
    "| Collection | Handle | Rule | Menu | Paintings |",
    "|---|---|---|---|---|",
    ...create.map(line),
    "",
    `## Existing collections that grow (${grow.length})`,
    "",
    "| Collection | Handle | Rule | Menu | New paintings |",
    "|---|---|---|---|---|",
    ...grow.map(line),
    "",
    `## Hold until 12+ products (${hold.length})`,
    "",
    ...hold.map((item) => `- ${item.title} (tag \`${item.rule.match(/"(.+)"/)[1]}\`): ${item.count} paintings`),
    "",
    "## Notes",
    "",
    ...notes.slice(1).map((row) => `- ${row[0]}`),
    "",
  ].join("\n");
  assertClean(brief, "collections brief");
  const briefPath = path.join(OUT_DIR, "Paint Road - New Collections brief.md");
  fs.writeFileSync(briefPath, brief);
  console.log(xlsxPath);
  console.log(briefPath);
  console.log(`Create ${create.length}, grow ${grow.length}, hold ${hold.length}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
