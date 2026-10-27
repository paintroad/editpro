/**
 * Side-by-side: live old variant attrs vs what migrate-variant-matrix-v2 will set.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const { PRODUCT_DEFAULTS } = require("../lib/catalog-variant-templates");

const HANDLE = process.argv[2] || "soulful-serenity";

async function main() {
  const c = getShopifyCredentials();
  const data = await shopifyGraphql(
    c.storeDomain,
    c.accessToken,
    `query ($q: String!) {
      products(first: 1, query: $q) {
        nodes {
          handle
          variants(first: 50) {
            nodes {
              sku barcode price compareAtPrice taxable inventoryPolicy inventoryQuantity
              selectedOptions { name value }
              inventoryItem {
                tracked requiresShipping countryCodeOfOrigin
                unitCost { amount }
                measurement { weight { value unit } }
                inventoryLevels(first: 10) {
                  nodes {
                    location { name }
                    quantities(names: ["available"]) { name quantity }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { q: `handle:${HANDLE}` }
  );
  const product = data.products?.nodes?.[0];
  if (!product) throw new Error("not found");

  const byFrame = (frameWanted, materialWanted = "Canvas") =>
    product.variants.nodes.find((v) => {
      const o = Object.fromEntries(
        (v.selectedOptions || []).map((x) => [
          String(x.name).toLowerCase(),
          x.value,
        ])
      );
      const matOk =
        !o.material ||
        String(o.material).toLowerCase() === materialWanted.toLowerCase();
      return matOk && String(o.frame || "").toLowerCase() === frameWanted;
    });

  const stretched = byFrame("stretched canvas");
  const black = byFrame("black");

  function levels(v) {
    return (v?.inventoryItem?.inventoryLevels?.nodes || []).map((n) => {
      const avail = (n.quantities || []).find((q) => q.name === "available");
      return `${n.location?.name}=${avail?.quantity ?? "?"}`;
    });
  }

  function row(label, v) {
    if (!v) return { label, missing: true };
    return {
      label,
      sku: v.sku,
      barcode: v.barcode || "(empty)",
      price: v.price,
      compareAt: v.compareAtPrice,
      taxable: v.taxable,
      inventoryPolicy: v.inventoryPolicy,
      tracked: v.inventoryItem?.tracked,
      requiresShipping: v.inventoryItem?.requiresShipping,
      countryCodeOfOrigin: v.inventoryItem?.countryCodeOfOrigin || "(null)",
      cost: v.inventoryItem?.unitCost?.amount,
      weight: v.inventoryItem?.measurement?.weight,
      stockByLocation: levels(v),
    };
  }

  const newCreateSpec = {
    label: "NEW create (migrate v2 after fix)",
    sku: "{id}-{SIZE}-{n}",
    barcode: "(empty — same as old)",
    price: "from template",
    compareAt: "from template",
    taxable: true,
    inventoryPolicy: "CONTINUE",
    tracked: true,
    requiresShipping: true,
    countryCodeOfOrigin: PRODUCT_DEFAULTS.countryOfOrigin,
    cost: "from template (stretched vs framed)",
    weight: "from weight table (g)",
    stockByLocation: {
      coloured: ["Nariana Warehouse=100"],
      stretched: ["Mayapuri Warehouse=100 only — no Naraina"],
    },
    shippingPackageId: "set when size in shipping-package-map.json",
  };

  const attrs = [
    "sku",
    "barcode",
    "price",
    "compareAt",
    "taxable",
    "inventoryPolicy",
    "tracked",
    "requiresShipping",
    "countryCodeOfOrigin",
    "cost",
    "weight",
    "stockByLocation",
  ];

  const oldS = row("OLD stretched", stretched);
  const oldB = row("OLD canvas black", black);

  console.log("\n=== LIVE OLD (soulful-serenity) ===\n");
  console.log(JSON.stringify({ stretched: oldS, canvasBlack: oldB }, null, 2));

  console.log("\n=== NEW CREATE SPEC (migrate script) ===\n");
  console.log(JSON.stringify(newCreateSpec, null, 2));

  console.log("\n=== GAP CHECK vs OLD ===\n");
  const gaps = [];
  // Check script implications
  const checks = [
    ["taxable", true, oldB.taxable, oldS.taxable],
    ["inventoryPolicy", "CONTINUE", oldB.inventoryPolicy, oldS.inventoryPolicy],
    ["tracked", true, oldB.tracked, oldS.tracked],
    ["requiresShipping", true, oldB.requiresShipping, oldS.requiresShipping],
    ["countryCodeOfOrigin", "IN", "IN (forced)", oldS.countryCodeOfOrigin],
    ["barcode", "(empty)", oldB.barcode, oldS.barcode],
    [
      "stock coloured @ Nariana 100",
      true,
      (oldB.stockByLocation || []).some((s) => /Nariana.*=100/.test(s)),
      null,
    ],
    [
      "stock stretched @ Mayapuri 100",
      true,
      (oldS.stockByLocation || []).some((s) => /Mayapuri.*=100/.test(s)),
      null,
    ],
    [
      "stock stretched @ Nariana 0",
      true,
      (oldS.stockByLocation || []).some((s) => /Nariana.*=0/.test(s)),
      null,
    ],
  ];
  for (const [name, expected, liveB, liveS] of checks) {
    console.log(`✓ ${name}: new=${JSON.stringify(expected)} | old black=${JSON.stringify(liveB)} | old stretched=${JSON.stringify(liveS)}`);
  }

  const mapPath = path.join(os.homedir(), ".editpro", "shipping-package-map.json");
  const map = fs.existsSync(mapPath)
    ? JSON.parse(fs.readFileSync(mapPath, "utf8"))
    : {};
  const missingPkg = ["12x12", "12x16", "18x18", "18x24", "24x24", "24x36", "36x36", "36x48"].filter(
    (k) => !map[k]
  );
  if (missingPkg.length) {
    gaps.push(`shipping-package-map missing: ${missingPkg.join(", ")}`);
  }
  console.log(
    missingPkg.length
      ? `\n⚠ Remaining gap: shipping packages not mapped for ${missingPkg.join(", ")}`
      : "\n✓ All active size packages mapped"
  );
  if (gaps.length) console.log(gaps.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
