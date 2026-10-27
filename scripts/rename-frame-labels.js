#!/usr/bin/env node
/**
 * Rename Frame metaobject labels:
 *   Wooden Finish → Wooden
 *   Dark Wood Finish → Dark Brown
 *
 * Usage:
 *   node scripts/rename-frame-labels.js
 *   node scripts/rename-frame-labels.js --apply
 *   node scripts/rename-frame-labels.js --apply --handles=soulful-serenity
 */

const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const RENAMES = [
  {
    key: "wooden",
    gid: "gid://shopify/Metaobject/86961782933",
    from: "Wooden Finish",
    to: "Wooden",
  },
  {
    key: "dark-wood",
    gid: "gid://shopify/Metaobject/249222332565",
    from: "Dark Wood Finish",
    to: "Dark Brown",
  },
];

const OLD_LABELS = new Set(RENAMES.map((r) => r.from));
const NEW_BY_OLD = Object.fromEntries(RENAMES.map((r) => [r.from, r.to]));

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  let handles = [];
  for (const arg of argv) {
    if (arg.startsWith("--handles=")) {
      handles = arg
        .slice("--handles=".length)
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
    }
  }
  return { apply, handles };
}

async function updateMetaobjectLabel(storeDomain, accessToken, gid, label) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation UpdateFrameLabel($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id displayName fields { key value } }
        userErrors { field message code }
      }
    }`,
    {
      id: gid,
      metaobject: {
        fields: [{ key: "label", value: label }],
      },
    }
  );
  const errors = data.metaobjectUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  const fields = data.metaobjectUpdate?.metaobject?.fields || [];
  const labelField = fields.find((f) => f.key === "label");
  return {
    id: data.metaobjectUpdate?.metaobject?.id,
    displayName: data.metaobjectUpdate?.metaobject?.displayName,
    label: labelField?.value,
  };
}

async function fetchMetaobject(storeDomain, accessToken, gid) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query Metaobject($id: ID!) {
      metaobject(id: $id) {
        id
        displayName
        fields { key value }
      }
    }`,
    { id: gid }
  );
  const mo = data.metaobject;
  if (!mo) return null;
  const label = (mo.fields || []).find((f) => f.key === "label")?.value;
  return { id: mo.id, displayName: mo.displayName, label };
}

async function fetchProductPage(storeDomain, accessToken, cursor, query) {
  return shopifyGraphql(
    storeDomain,
    accessToken,
    `query Products($cursor: String, $query: String) {
      products(first: 50, after: $cursor, query: $query) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          handle
          options {
            id
            name
            optionValues { id name linkedMetafieldValue }
          }
          variantsCount { count }
        }
      }
    }`,
    { cursor: cursor || null, query: query || null }
  );
}

function frameOption(product) {
  return (product.options || []).find(
    (o) => String(o.name || "").toLowerCase() === "frame"
  );
}

function collectOldFrameValues(product) {
  const option = frameOption(product);
  if (!option) return [];
  return (option.optionValues || []).filter((v) => OLD_LABELS.has(v.name));
}

async function renameProductFrameValues(
  storeDomain,
  accessToken,
  product,
  apply
) {
  const option = frameOption(product);
  if (!option) return { skipped: true, reason: "no-frame-option" };
  const toUpdate = collectOldFrameValues(product);
  if (!toUpdate.length) return { skipped: true, reason: "no-old-labels" };

  const valuesToUpdate = toUpdate.map((v) => ({
    id: v.id,
    name: NEW_BY_OLD[v.name],
  }));

  if (!apply) {
    return {
      dryRun: true,
      handle: product.handle,
      updates: valuesToUpdate.map((u, i) => ({
        from: toUpdate[i].name,
        to: u.name,
        id: u.id,
      })),
    };
  }

  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation RenameFrameValues(
      $productId: ID!
      $option: OptionUpdateInput!
      $optionValuesToUpdate: [OptionValueUpdateInput!]
      $variantStrategy: ProductOptionUpdateVariantStrategy
    ) {
      productOptionUpdate(
        productId: $productId
        option: $option
        optionValuesToUpdate: $optionValuesToUpdate
        variantStrategy: $variantStrategy
      ) {
        userErrors { field message code }
        product {
          options {
            id
            name
            optionValues { id name linkedMetafieldValue }
          }
        }
      }
    }`,
    {
      productId: product.id,
      option: { id: option.id },
      optionValuesToUpdate: valuesToUpdate,
      variantStrategy: "LEAVE_AS_IS",
    }
  );
  const errors = data.productOptionUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return {
    updated: true,
    handle: product.handle,
    updates: valuesToUpdate.map((u, i) => ({
      from: toUpdate[i].name,
      to: u.name,
    })),
  };
}

async function spotCheckProducts(storeDomain, accessToken, handles) {
  const results = [];
  const query =
    handles.length > 0
      ? handles.map((h) => `handle:${h}`).join(" OR ")
      : null;

  let cursor = null;
  let pages = 0;
  const maxPages = handles.length > 0 ? 5 : 1;

  while (pages < maxPages) {
    const data = await fetchProductPage(
      storeDomain,
      accessToken,
      cursor,
      query
    );
    const connection = data.products;
    for (const product of connection?.nodes || []) {
      const option = frameOption(product);
      const frameNames = (option?.optionValues || []).map((v) => v.name);
      results.push({
        handle: product.handle,
        title: product.title,
        variantCount: product.variantsCount?.count ?? null,
        frameNames,
        hasWooden: frameNames.includes("Wooden"),
        hasDarkBrown: frameNames.includes("Dark Brown"),
        hasOldWoodenFinish: frameNames.includes("Wooden Finish"),
        hasOldDarkWoodFinish: frameNames.includes("Dark Wood Finish"),
      });
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
    pages += 1;
    if (handles.length === 0) break;
  }
  return results;
}

async function findStragglers(storeDomain, accessToken) {
  const stragglers = [];
  let cursor = null;
  do {
    const data = await fetchProductPage(storeDomain, accessToken, cursor, null);
    const connection = data.products;
    for (const product of connection?.nodes || []) {
      const oldValues = collectOldFrameValues(product);
      if (oldValues.length) {
        stragglers.push(product);
      }
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  } while (cursor);
  return stragglers;
}

async function main() {
  const { apply, handles } = parseArgs(process.argv.slice(2));
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Missing Shopify credentials in ~/.editpro/config.json");
  }

  console.log(apply ? "Mode: APPLY" : "Mode: DRY-RUN (pass --apply to write)");
  console.log("");

  console.log("=== Metaobject labels ===");
  for (const rename of RENAMES) {
    const current = await fetchMetaobject(storeDomain, accessToken, rename.gid);
    console.log(
      `${rename.key}: current label=${JSON.stringify(current?.label)} displayName=${JSON.stringify(current?.displayName)}`
    );
    if (current?.label === rename.to) {
      console.log(`  already "${rename.to}" — skip`);
      continue;
    }
    if (!apply) {
      console.log(`  would set label → "${rename.to}"`);
      continue;
    }
    const updated = await updateMetaobjectLabel(
      storeDomain,
      accessToken,
      rename.gid,
      rename.to
    );
    console.log(
      `  updated → label=${JSON.stringify(updated.label)} displayName=${JSON.stringify(updated.displayName)}`
    );
  }

  console.log("");
  console.log("=== Spot-check products ===");
  // Linked option names can lag briefly after metaobjectUpdate.
  if (apply) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  const checks = await spotCheckProducts(storeDomain, accessToken, handles);
  for (const row of checks.slice(0, 5)) {
    console.log(
      `${row.handle}: variants=${row.variantCount} frames=[${row.frameNames.join(", ")}]`
    );
  }
  if (!checks.length) {
    console.log("(no products found for spot-check)");
  }

  const stillOld = checks.filter(
    (c) => c.hasOldWoodenFinish || c.hasOldDarkWoodFinish
  );
  if (!apply) {
    if (stillOld.length) {
      console.log(
        `Dry-run: ${stillOld.length} sampled product(s) still show Finish labels (expected until metaobject update).`
      );
    }
  } else if (stillOld.length) {
    console.log("");
    console.log(
      `After metaobject update, ${stillOld.length} sampled product(s) still show Finish labels; scanning for unlinked stragglers…`
    );
    const stragglers = await findStragglers(storeDomain, accessToken);
    console.log(`Found ${stragglers.length} product(s) with old Frame labels`);
    let fixed = 0;
    let skippedLinked = 0;
    for (const product of stragglers) {
      const option = frameOption(product);
      const oldValues = collectOldFrameValues(product);
      const unlinked = oldValues.filter((v) => !v.linkedMetafieldValue);
      if (!unlinked.length) {
        skippedLinked += 1;
        continue;
      }
      // Only rename unlinked leftovers; linked names come from metaobject label.
      const result = await renameProductFrameValues(
        storeDomain,
        accessToken,
        {
          ...product,
          options: (product.options || []).map((o) =>
            o.id === option.id
              ? { ...o, optionValues: unlinked }
              : o
          ),
        },
        true
      );
      if (result.updated) {
        fixed += 1;
        console.log(
          `  fixed ${product.handle}: ${result.updates.map((u) => `${u.from}→${u.to}`).join(", ")}`
        );
      }
    }
    console.log(
      `Straggler renames applied: ${fixed}; linked (skipped name update): ${skippedLinked}`
    );
  } else if (checks.length) {
    console.log("Spot-check: no Finish labels remaining on sampled products.");
  }

  if (apply && checks.length) {
    console.log("");
    console.log("=== Re-verify after updates ===");
    const recheck = await spotCheckProducts(storeDomain, accessToken, handles);
    for (const row of recheck.slice(0, 5)) {
      console.log(
        `${row.handle}: variants=${row.variantCount} frames=[${row.frameNames.join(", ")}]`
      );
    }
    const leftover = recheck.filter(
      (c) => c.hasOldWoodenFinish || c.hasOldDarkWoodFinish
    );
    if (leftover.length) {
      console.warn(
        `WARNING: ${leftover.length} sampled product(s) still have Finish labels.`
      );
    } else {
      console.log("Re-verify OK: Wooden / Dark Brown present, Finish names gone.");
    }
  }

  console.log("");
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
