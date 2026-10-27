#!/usr/bin/env node
/**
 * Restore Paintroad gift-card denominations:
 *   ₹1,000 · ₹2,000 · ₹5,000 · ₹10,000
 *
 * Usage:
 *   node scripts/restore-gift-card-variants.js
 *   node scripts/restore-gift-card-variants.js --apply
 */

const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const HANDLE = "gift-card";
const DENOMS = [
  { amount: "1000.00", label: "₹1,000", sku: "GIFT-1000" },
  { amount: "2000.00", label: "₹2,000", sku: "GIFT-2000" },
  { amount: "5000.00", label: "₹5,000", sku: "GIFT-5000" },
  { amount: "10000.00", label: "₹10,000", sku: "GIFT-10000" },
];

function parseArgs(argv) {
  return { apply: argv.includes("--apply") };
}

async function fetchGiftCard(storeDomain, accessToken) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `{
      products(first: 1, query: "handle:${HANDLE}") {
        nodes {
          id
          title
          handle
          isGiftCard
          options { id name position values }
          variants(first: 50) {
            nodes {
              id
              title
              price
              sku
              selectedOptions { name value }
            }
          }
        }
      }
    }`
  );
  const product = data.products.nodes[0];
  if (!product) throw new Error(`Product handle=${HANDLE} not found`);
  return product;
}

async function ensureDenominationOption(storeDomain, accessToken, product) {
  const existing = (product.options || []).find(
    (o) =>
      /denomination|amount|title/i.test(String(o.name || "")) ||
      product.options.length === 1
  );

  // Prefer renaming/using a clear Denomination option
  if (existing && String(existing.name).toLowerCase() === "denomination") {
    return existing;
  }

  // Create Denomination option with all values (strategy keeps existing variants briefly)
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ($productId: ID!, $options: [OptionCreateInput!]!, $variantStrategy: ProductOptionCreateVariantStrategy) {
      productOptionsCreate(
        productId: $productId
        options: $options
        variantStrategy: $variantStrategy
      ) {
        userErrors { field message }
        product {
          id
          options { id name position values }
          variants(first: 50) {
            nodes { id title price sku selectedOptions { name value } }
          }
        }
      }
    }`,
    {
      productId: product.id,
      options: [
        {
          name: "Denomination",
          values: DENOMS.map((d) => ({ name: d.label })),
        },
      ],
      variantStrategy: "CREATE",
    }
  );

  const errors = data.productOptionsCreate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.productOptionsCreate.product;
}

async function deleteExtraOptions(storeDomain, accessToken, product) {
  const extras = (product.options || []).filter(
    (o) => String(o.name).toLowerCase() !== "denomination"
  );
  if (!extras.length) return product;

  for (const opt of extras) {
    // Only safe if Denomination already exists and carries variants
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ($productId: ID!, $options: [ID!]!, $strategy: ProductOptionDeleteStrategy) {
        productOptionsDelete(productId: $productId, options: $options, strategy: $strategy) {
          userErrors { field message }
          product {
            id
            options { id name position values }
            variants(first: 50) {
              nodes { id title price sku selectedOptions { name value } }
            }
          }
        }
      }`,
      {
        productId: product.id,
        options: [opt.id],
        strategy: "POSITION",
      }
    );
    const errors = data.productOptionsDelete?.userErrors || [];
    if (errors.length) {
      console.warn(
        `  option delete warn (${opt.name}):`,
        errors.map((e) => e.message).join("; ")
      );
    } else if (data.productOptionsDelete?.product) {
      product = data.productOptionsDelete.product;
    }
  }
  return product;
}

async function syncVariantPrices(storeDomain, accessToken, product) {
  const variants = product.variants?.nodes || [];
  const updates = [];
  const creates = [];
  const keepIds = new Set();

  for (const denom of DENOMS) {
    const match = variants.find((v) => {
      const opt = (v.selectedOptions || []).find((o) =>
        /denomination|title|amount/i.test(o.name)
      );
      const val = String(opt?.value || v.title || "");
      return (
        val === denom.label ||
        val.replace(/[^\d]/g, "") === denom.amount.replace(/\.00$/, "") ||
        Number(v.price) === Number(denom.amount)
      );
    });

    if (match) {
      keepIds.add(match.id);
      updates.push({
        id: match.id,
        price: denom.amount,
        compareAtPrice: null,
        optionValues: [{ optionName: "Denomination", name: denom.label }],
        inventoryItem: { sku: denom.sku, tracked: false, requiresShipping: false },
      });
    } else {
      creates.push({
        price: denom.amount,
        optionValues: [{ optionName: "Denomination", name: denom.label }],
        inventoryItem: { sku: denom.sku, tracked: false, requiresShipping: false },
      });
    }
  }

  if (updates.length) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
          productVariants { id title price sku }
        }
      }`,
      { productId: product.id, variants: updates }
    );
    const errors = data.productVariantsBulkUpdate?.userErrors || [];
    if (errors.length) {
      throw new Error(
        "update: " + errors.map((e) => e.message).join("; ")
      );
    }
    console.log(
      "  updated",
      data.productVariantsBulkUpdate.productVariants.map(
        (v) => `${v.title}=${v.price}`
      )
    );
  }

  if (creates.length) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          userErrors { field message }
          productVariants { id title price sku }
        }
      }`,
      { productId: product.id, variants: creates }
    );
    const errors = data.productVariantsBulkCreate?.userErrors || [];
    if (errors.length) {
      throw new Error(
        "create: " + errors.map((e) => e.message).join("; ")
      );
    }
    for (const v of data.productVariantsBulkCreate.productVariants || []) {
      keepIds.add(v.id);
    }
    console.log(
      "  created",
      (data.productVariantsBulkCreate.productVariants || []).map(
        (v) => `${v.title}=${v.price}`
      )
    );
  }

  // Refresh and delete leftovers
  const refreshed = await fetchGiftCard(storeDomain, accessToken);
  const toDelete = (refreshed.variants.nodes || [])
    .filter((v) => {
      const opt = (v.selectedOptions || []).find((o) =>
        /denomination|title|amount/i.test(o.name)
      );
      const val = String(opt?.value || v.title || "");
      return !DENOMS.some(
        (d) =>
          d.label === val ||
          Number(v.price) === Number(d.amount) ||
          v.sku === d.sku
      );
    })
    .map((v) => v.id);

  if (toDelete.length) {
    // Never delete all — leave at least the four denoms
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `mutation ($productId: ID!, $variantsIds: [ID!]!) {
        productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
          userErrors { field message }
        }
      }`,
      { productId: product.id, variantsIds: toDelete }
    );
    const errors = data.productVariantsBulkDelete?.userErrors || [];
    if (errors.length) {
      console.warn(
        "  delete warn:",
        errors.map((e) => e.message).join("; ")
      );
    } else {
      console.log("  deleted leftover variants:", toDelete.length);
    }
  }

  return fetchGiftCard(storeDomain, accessToken);
}

/**
 * Simpler path for gift cards: replace option values on the single Title option
 * via productOptionsCreate or productVariant bulk with denomination labels.
 */
async function rebuildViaOptionsReplace(storeDomain, accessToken, product) {
  // Strategy: update existing option to Denomination with 4 values using CREATE strategy,
  // which generates the variant matrix from option values.
  const option = (product.options || [])[0];
  if (!option) throw new Error("Gift card has no options");

  // Rename/replace values on existing option
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation ($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!], $optionValuesToUpdate: [OptionValueUpdateInput!], $optionValuesToDelete: [ID!], $variantStrategy: ProductOptionUpdateVariantStrategy) {
      productOptionUpdate(
        productId: $productId
        option: $option
        optionValuesToAdd: $optionValuesToAdd
        optionValuesToUpdate: $optionValuesToUpdate
        optionValuesToDelete: $optionValuesToDelete
        variantStrategy: $variantStrategy
      ) {
        userErrors { field message code }
        product {
          id
          options { id name position values }
          variants(first: 50) {
            nodes { id title price sku selectedOptions { name value } }
          }
        }
      }
    }`,
    {
      productId: product.id,
      option: { id: option.id, name: "Denomination" },
      optionValuesToAdd: DENOMS.map((d) => ({ name: d.label })),
      optionValuesToUpdate: [],
      optionValuesToDelete: [],
      variantStrategy: "MANAGE",
    }
  );

  const errors = data.productOptionUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => `${e.code || ""} ${e.message}`).join("; "));
  }
  return data.productOptionUpdate.product;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const c = getShopifyCredentials();
  let product = await fetchGiftCard(c.storeDomain, c.accessToken);

  console.log("Product:", product.title, product.id);
  console.log("isGiftCard:", product.isGiftCard);
  console.log(
    "Current variants:",
    product.variants.nodes.map((v) => `${v.title} ₹${v.price} [${v.sku}]`).join(" | ")
  );
  console.log("Target:", DENOMS.map((d) => d.label).join(" · "));

  if (!args.apply) {
    console.log("\nDry run only. Re-run with --apply to write.");
    return;
  }

  if (!product.isGiftCard) {
    console.warn("WARNING: product.isGiftCard is false — continuing anyway");
  }

  // Path A: add Denomination values onto existing option and manage variants
  try {
    console.log("\n1) Updating option → Denomination + values…");
    product = await rebuildViaOptionsReplace(
      c.storeDomain,
      c.accessToken,
      product
    );
    console.log(
      "  options:",
      product.options.map((o) => `${o.name}=[${o.values.join(", ")}]`).join("; ")
    );
    console.log(
      "  variants after option update:",
      product.variants.nodes.map((v) => `${v.title} ₹${v.price}`).join(" | ")
    );
  } catch (e) {
    console.warn("  option update failed:", e.message);
    console.log("  falling back to productOptionsCreate…");
    product = await ensureDenominationOption(
      c.storeDomain,
      c.accessToken,
      product
    );
    if (product.variants) {
      // ensureDenominationOption returns product
    } else {
      product = await fetchGiftCard(c.storeDomain, c.accessToken);
    }
  }

  console.log("\n2) Syncing prices + SKUs…");
  product = await syncVariantPrices(c.storeDomain, c.accessToken, product);

  // Prune non-denomination options if any remain
  product = await fetchGiftCard(c.storeDomain, c.accessToken);
  if ((product.options || []).some((o) => o.name !== "Denomination")) {
    console.log("\n3) Removing extra options…");
    product = await deleteExtraOptions(c.storeDomain, c.accessToken, product);
    product = await syncVariantPrices(c.storeDomain, c.accessToken, product);
  }

  const final = await fetchGiftCard(c.storeDomain, c.accessToken);
  console.log("\nDONE");
  console.log(
    "Options:",
    final.options.map((o) => `${o.name}: ${o.values.join(", ")}`).join(" | ")
  );
  console.log(
    "Variants:",
    final.variants.nodes
      .map((v) => `${v.title} → ₹${v.price} (${v.sku || "no-sku"})`)
      .join("\n  ")
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
