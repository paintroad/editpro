#!/usr/bin/env node
/**
 * Rename Frame metaobject handles:
 *   dark-wood-finish → dark-brown
 *   black-frame → black
 *
 * Usage:
 *   node scripts/rename-frame-metaobject-handles.js
 *   node scripts/rename-frame-metaobject-handles.js --apply
 */

const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

const HANDLE_RENAMES = [
  {
    key: "dark-brown",
    gid: "gid://shopify/Metaobject/249222332565",
    from: "dark-wood-finish",
    to: "dark-brown",
  },
  {
    key: "black",
    gid: "gid://shopify/Metaobject/86961586325",
    from: "black-frame",
    to: "black",
  },
];

function parseArgs(argv) {
  return { apply: argv.includes("--apply") };
}

async function fetchMetaobject(storeDomain, accessToken, gid) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query Metaobject($id: ID!) {
      metaobject(id: $id) {
        id
        handle
        displayName
        fields { key value }
      }
    }`,
    { id: gid }
  );
  return data.metaobject;
}

async function updateHandle(storeDomain, accessToken, gid, handle) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation UpdateFrameHandle($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id handle displayName fields { key value } }
        userErrors { field message code }
      }
    }`,
    {
      id: gid,
      metaobject: {
        handle,
        redirectNewHandle: true,
      },
    }
  );
  const errors = data.metaobjectUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.metaobjectUpdate?.metaobject;
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Missing Shopify credentials in ~/.editpro/config.json");
  }

  console.log(apply ? "Mode: APPLY" : "Mode: DRY-RUN (pass --apply to write)");
  console.log("");

  for (const rename of HANDLE_RENAMES) {
    const current = await fetchMetaobject(storeDomain, accessToken, rename.gid);
    console.log(
      `${rename.key}: handle=${JSON.stringify(current?.handle)} label=${JSON.stringify(
        (current?.fields || []).find((f) => f.key === "label")?.value
      )}`
    );
    if (current?.handle === rename.to) {
      console.log(`  already "${rename.to}" — skip`);
      continue;
    }
    if (current?.handle !== rename.from && current?.handle !== rename.to) {
      console.warn(
        `  unexpected handle ${JSON.stringify(current?.handle)}; expected ${JSON.stringify(rename.from)}`
      );
    }
    if (!apply) {
      console.log(`  would set handle → "${rename.to}"`);
      continue;
    }
    const updated = await updateHandle(
      storeDomain,
      accessToken,
      rename.gid,
      rename.to
    );
    console.log(`  updated → handle=${JSON.stringify(updated?.handle)}`);
  }

  console.log("");
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
