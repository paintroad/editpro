#!/usr/bin/env node
/**
 * Finish the 8 remaining non-1:1 collection featured images:
 * 1) Ensure a square Shopify File exists for each
 * 2) Assign that File URL onto the collection via collectionUpdate
 *
 * Usage:
 *   node scripts/finish-remaining-collection-images.js
 *   node scripts/finish-remaining-collection-images.js --apply
 *
 * Report: ~/.editpro/finish-remaining-collection-images-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const { mimeTypeForPath } = require("../lib/shopify-staged-upload");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(
  CONFIG_DIR,
  "finish-remaining-collection-images-report.json"
);
const LOCAL_FOLDER = "C:\\Users\\divya\\Downloads\\Collection Images";
const TEMP_DIR = path.join(CONFIG_DIR, "tmp-remaining-collection-images");

/**
 * handle -> { filename, localPath?, productFallback? }
 * If File already exists and is square, reuse it.
 * Else upload localPath, else download first product cover and upload.
 */
const REMAINING = {
  bauhaus: {
    filename: "collection-bauhaus.jpg",
    productFallback: true,
  },
  "botanical-prints": {
    filename: "collection-botanical-prints.jpg",
    localPath: path.join(LOCAL_FOLDER, "collection-botanical-prints.jpg"),
  },
  cocktails: {
    filename: "collection-cocktail.jpg",
    productFallback: true,
  },
  "lord-buddha": {
    filename: "collection-buddha.jpg",
    productFallback: true,
  },
  "lord-hanuman": {
    filename: "collection-hanuman.jpg",
    productFallback: true,
  },
  "mattise-style": {
    filename: "collection-matisse-style.jpg",
    productFallback: true,
  },
  "picasso-style": {
    filename: "collection-picasso-style.jpg",
    productFallback: true,
  },
  "sun-signs": {
    filename: "collection-sun-signs.jpg",
    productFallback: true,
  },
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function filenameFromUrl(url) {
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return "";
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCollectionByHandle(storeDomain, accessToken, handle) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query CollectionByHandle($handle: String!) {
      collectionByHandle(handle: $handle) {
        id
        title
        handle
        image { url width height altText }
        products(first: 1) {
          nodes {
            title
            featuredMedia {
              ... on MediaImage {
                image { url width height }
              }
            }
          }
        }
      }
    }`,
    { handle }
  );
  return data.collectionByHandle || null;
}

async function findFileByExactFilename(storeDomain, accessToken, filename) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query FileByFilename($query: String!) {
      files(first: 25, query: $query) {
        nodes {
          id
          fileStatus
          ... on MediaImage {
            id
            image { url width height }
          }
        }
      }
    }`,
    { query: `filename:${filename}` }
  );

  const target = String(filename).toLowerCase();
  const matches = [];
  for (const node of data.files?.nodes || []) {
    const url = node?.image?.url;
    if (!url) continue;
    const name = filenameFromUrl(url).toLowerCase();
    if (name !== target) continue;
    matches.push({
      id: node.id,
      url,
      width: Number(node.image.width) || 0,
      height: Number(node.image.height) || 0,
      fileStatus: node.fileStatus || "",
    });
  }
  return matches;
}

async function stagedUploadAsFile(storeDomain, accessToken, localPath, filename) {
  const mimeType = mimeTypeForPath(localPath);
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          filename,
          mimeType,
          resource: "FILE",
          httpMethod: "POST",
        },
      ],
    }
  );
  const result = data.stagedUploadsCreate;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  const target = result.stagedTargets?.[0];
  if (!target?.url || !target.resourceUrl) {
    throw new Error("Staged upload target missing.");
  }

  const fileBuffer = fs.readFileSync(localPath);
  const form = new FormData();
  for (const param of target.parameters || []) {
    form.append(param.name, param.value);
  }
  form.append("file", new Blob([fileBuffer], { type: mimeType }), filename);

  const uploadResponse = await fetch(target.url, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => "");
    throw new Error(
      `Staged upload failed (${uploadResponse.status}): ${text.slice(0, 200)}`
    );
  }

  return { resourceUrl: target.resourceUrl, filename, mimeType };
}

async function fileCreate(storeDomain, accessToken, resourceUrl, filename, alt) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation FileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage {
            image { url width height }
          }
        }
        userErrors { field message code }
      }
    }`,
    {
      files: [
        {
          originalSource: resourceUrl,
          filename,
          contentType: "IMAGE",
          alt: alt || filename,
        },
      ],
    }
  );
  const errors = data.fileCreate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.fileCreate?.files?.[0] || null;
}

async function fileUpdateContent(storeDomain, accessToken, fileId, resourceUrl) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation FileUpdate($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage {
            image { url width height }
          }
        }
        userErrors { field message code }
      }
    }`,
    {
      files: [{ id: fileId, originalSource: resourceUrl }],
    }
  );
  const errors = data.fileUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.fileUpdate?.files?.[0] || null;
}

async function waitForSquareFile(storeDomain, accessToken, filename, attempts = 12) {
  for (let i = 0; i < attempts; i += 1) {
    const matches = await findFileByExactFilename(
      storeDomain,
      accessToken,
      filename
    );
    const ready = matches.find(
      (m) =>
        m.width > 0 &&
        m.height > 0 &&
        m.width === m.height &&
        m.fileStatus !== "PROCESSING"
    );
    if (ready) return ready;
    await sleep(1500);
  }
  const late = await findFileByExactFilename(storeDomain, accessToken, filename);
  return late[0] || null;
}

async function downloadToTemp(url, filename) {
  ensureDir(TEMP_DIR);
  const localPath = path.join(TEMP_DIR, filename);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(localPath, buf);
  return localPath;
}

async function updateCollectionImage(storeDomain, accessToken, collectionId, imageUrl) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation CollectionUpdate($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        collection {
          id
          title
          handle
          image { url width height }
        }
        userErrors { field message }
      }
    }`,
    {
      input: {
        id: collectionId,
        image: { src: imageUrl },
      },
    }
  );
  const errors = data.collectionUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.collectionUpdate?.collection || null;
}

async function ensureSquareFile(storeDomain, accessToken, handle, spec, collection, apply) {
  const existing = await findFileByExactFilename(
    storeDomain,
    accessToken,
    spec.filename
  );
  const squareExisting = existing.find(
    (m) => m.width > 0 && m.height > 0 && m.width === m.height
  );
  if (squareExisting) {
    return {
      action: "reuse",
      file: squareExisting,
      source: "existing-square-file",
    };
  }

  let localPath = null;
  let source = "";

  if (spec.localPath && fs.existsSync(spec.localPath)) {
    localPath = spec.localPath;
    source = "local-folder";
  } else if (spec.productFallback) {
    const productImage = collection.products?.nodes?.[0]?.featuredMedia?.image;
    if (!productImage?.url) {
      throw new Error("No local file and no product featured image for fallback.");
    }
    if (
      !productImage.width ||
      !productImage.height ||
      productImage.width !== productImage.height
    ) {
      throw new Error(
        `Product fallback not square (${productImage.width}x${productImage.height}).`
      );
    }
    localPath = await downloadToTemp(productImage.url, spec.filename);
    source = `product:${collection.products.nodes[0].title}`;
  } else {
    throw new Error("No source available to create square File.");
  }

  if (!apply) {
    return {
      action: existing[0] ? "plan-replace" : "plan-create",
      file: null,
      source,
      localPath,
      existingNonSquare: existing[0] || null,
    };
  }

  const staged = await stagedUploadAsFile(
    storeDomain,
    accessToken,
    localPath,
    spec.filename
  );

  if (existing[0]) {
    await fileUpdateContent(
      storeDomain,
      accessToken,
      existing[0].id,
      staged.resourceUrl
    );
  } else {
    await fileCreate(
      storeDomain,
      accessToken,
      staged.resourceUrl,
      spec.filename,
      collection.title
    );
  }

  const ready = await waitForSquareFile(
    storeDomain,
    accessToken,
    spec.filename
  );
  if (!ready || ready.width !== ready.height) {
    throw new Error(
      `File not ready/square after upload: ${spec.filename}` +
        (ready ? ` (${ready.width}x${ready.height})` : "")
    );
  }

  return {
    action: existing[0] ? "replaced" : "created",
    file: ready,
    source,
    localPath,
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }

  ensureDir(CONFIG_DIR);
  const handles = Object.keys(REMAINING);
  console.log(`Store: ${credentials.storeDomain}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Remaining collections: ${handles.length}`);
  console.log("");

  const results = [];
  let planned = 0;
  let updated = 0;
  let errors = 0;

  for (let i = 0; i < handles.length; i += 1) {
    const handle = handles[i];
    const spec = REMAINING[handle];
    process.stdout.write(`[${i + 1}/${handles.length}] ${handle} ← ${spec.filename}… `);

    try {
      const collection = await fetchCollectionByHandle(
        credentials.storeDomain,
        credentials.accessToken,
        handle
      );
      if (!collection?.id) {
        throw new Error("Collection not found.");
      }

      const ensured = await ensureSquareFile(
        credentials.storeDomain,
        credentials.accessToken,
        handle,
        spec,
        collection,
        apply
      );

      const entry = {
        handle,
        title: collection.title,
        filename: spec.filename,
        fileAction: ensured.action,
        fileSource: ensured.source,
        oldWidth: collection.image?.width || null,
        oldHeight: collection.image?.height || null,
        oldImageUrl: collection.image?.url || "",
      };

      if (!apply) {
        planned += 1;
        entry.status = "planned";
        entry.newImageUrl = ensured.file?.url || null;
        entry.newWidth = ensured.file?.width || null;
        entry.newHeight = ensured.file?.height || null;
        console.log(
          `PLAN ${entry.oldWidth || "?"}x${entry.oldHeight || "?"} → file:${ensured.action} (${ensured.source})`
        );
        results.push(entry);
        continue;
      }

      const fileUrl = ensured.file.url;
      await updateCollectionImage(
        credentials.storeDomain,
        credentials.accessToken,
        collection.id,
        fileUrl
      );

      // Allow Shopify a moment to process collection image copy
      await sleep(1200);
      const refreshed = await fetchCollectionByHandle(
        credentials.storeDomain,
        credentials.accessToken,
        handle
      );
      const rw = Number(refreshed?.image?.width) || 0;
      const rh = Number(refreshed?.image?.height) || 0;
      const square = rw > 0 && rw === rh;

      updated += 1;
      entry.status = square ? "updated" : "updated-unverified";
      entry.newImageUrl = refreshed?.image?.url || fileUrl;
      entry.verifiedWidth = rw || null;
      entry.verifiedHeight = rh || null;
      entry.fileUrl = fileUrl;
      console.log(
        `${entry.status.toUpperCase()} → ${rw || "?"}x${rh || "?"} (file ${ensured.action})`
      );
      results.push(entry);
    } catch (error) {
      errors += 1;
      console.log(`ERROR: ${error.message || error}`);
      results.push({
        handle,
        filename: spec.filename,
        status: "error",
        reason: error.message || String(error),
      });
    }
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    remaining: handles.length,
    planned,
    updated,
    errors,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2), "utf8");

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`Remaining: ${summary.remaining}`);
  console.log(`Planned/applied: ${apply ? summary.updated : summary.planned}`);
  console.log(`Errors: ${summary.errors}`);
  console.log(`Report: ${REPORT_PATH}`);

  if (!apply) {
    console.log("");
    console.log("Dry-run complete. Re-run with --apply to upload Files and update collections.");
  }

  if (apply && summary.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
