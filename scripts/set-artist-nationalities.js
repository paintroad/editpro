#!/usr/bin/env node
/**
 * Resolve artist nationalities, create Country metaobjects (+ flags),
 * and set Artists.country references on Shopify.
 *
 * Usage:
 *   node scripts/set-artist-nationalities.js
 *   node scripts/set-artist-nationalities.js --apply
 */
const { applyArtistNationalities } = require("../lib/artists-countries");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");

async function spotCheckMonet() {
  const { storeDomain, accessToken } = getShopifyCredentials();
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query {
      metaobjects(type: "artists", first: 5, query: "handle:claude-monet") {
        nodes {
          handle
          fields { key value }
          field(key: "country") {
            reference {
              ... on Metaobject {
                handle
                fields { key value }
              }
            }
          }
        }
      }
    }`
  );
  return data.metaobjects?.nodes?.[0] || null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);

  const report = await applyArtistNationalities({ apply });

  console.log("");
  console.log("Artist → nationality:");
  for (const m of report.mappings) {
    console.log(
      `  ${m.artistName.padEnd(24)} → ${m.countryName} (${m.iso2})` +
        (m.onShopify ? " [on Shopify]" : "")
    );
  }
  console.log("");
  console.log(`Unique countries: ${report.uniqueCountries.join(", ")}`);
  console.log(`Countries upserted/cached: ${report.countries.length}`);
  console.log(`Artists linked on Shopify: ${report.linkedCount}`);
  if (report.errors.length) {
    console.log(`Errors: ${report.errors.length}`);
    for (const err of report.errors) {
      console.log(`  - ${JSON.stringify(err)}`);
    }
  }
  console.log(`Report: ${report.reportPath}`);

  if (apply) {
    try {
      const monet = await spotCheckMonet();
      console.log("");
      console.log("Spot-check claude-monet:");
      console.log(
        JSON.stringify(
          {
            handle: monet?.handle,
            countryHandle: monet?.field?.reference?.handle,
            countryName: monet?.field?.reference?.fields?.find(
              (f) => f.key === "name"
            )?.value,
          },
          null,
          2
        )
      );
    } catch (error) {
      console.error("Spot-check failed:", error.message || error);
    }
  } else {
    console.log("Dry run only — pass --apply to write countries and link artists.");
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
