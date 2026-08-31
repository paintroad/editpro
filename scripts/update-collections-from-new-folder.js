#!/usr/bin/env node
/**
 * Update Shopify collection featured images from local New folder.
 * Uses older Shopify File aliases (replace when exists, create when missing).
 *
 * Usage:
 *   node scripts/update-collections-from-new-folder.js
 *   node scripts/update-collections-from-new-folder.js --apply
 *
 * Folder: C:\Users\divya\Downloads\Collection Images\New
 * Report: ~/.editpro/update-collections-from-new-folder-report.json
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
  "update-collections-from-new-folder-report.json"
);
const NEW_FOLDER = "C:\\Users\\divya\\Downloads\\Collection Images\\New";

/**
 * localFilename -> { handle, shopifyFilename }
 * shopifyFilename is the older alias when it differs.
 */
const NEW_FILE_MAP = {
  "collection-animals.jpg": {
    handle: "animal",
    shopifyFilename: "collection-animal.jpg",
  },
  "collection-bauhaus.jpg": {
    handle: "bauhaus",
    shopifyFilename: "collection-bauhaus.jpg",
  },
  "collection-beach.jpg": {
    handle: "beach-vacation",
    shopifyFilename: "collection-beach-vacation.jpg",
  },
  "collection-cat-lovers.jpg": {
    handle: "cat-lovers",
    shopifyFilename: "collection-cat-lovers.jpg",
  },
  "collection-dog-lovers.jpg": {
    handle: "dog-lovers",
    shopifyFilename: "collection-dog-lovers.jpg",
  },
  "collection-famous-artists.jpg": {
    handle: "famous-artists",
    shopifyFilename: "collection-famous-artists.jpg",
  },
  "collection-gods.jpg": {
    handle: "gods",
    shopifyFilename: "collection-gods.jpg",
  },
  "collection-hindu-gods.jpg": {
    handle: "hindu-gods",
    shopifyFilename: "collection-hindu-gods.jpg",
  },
  "collection-indian.jpg": {
    handle: "indian-art-wall-paintings",
    shopifyFilename: "collection-indian.jpg",
  },
  "collection-intrinsic-patterns.jpg": {
    handle: "intricate-patterns",
    shopifyFilename: "collection-intricate-patterns.jpg",
  },
  "collection-maximalist.jpg": {
    handle: "maximalist",
    shopifyFilename: "collection-maximalist.jpg",
  },
  "collection-pop.jpg": {
    handle: "pop-art",
    shopifyFilename: "collection-pop-art.jpg",
  },
  "collection-travel.jpg": {
    handle: "travel",
    shopifyFilename: "collection-travel.jpg",
  },
};

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
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
        image { url width height }
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

async function waitForFile(storeDomain, accessToken, filename, attempts = 15) {
  for (let i = 0; i < attempts; i += 1) {
    const matches = await findFileByExactFilename(
      storeDomain,
      accessToken,
      filename
    );
    const ready = matches.find(
      (m) => m.url && m.width > 0 && m.height > 0 && m.fileStatus !== "PROCESSING"
    );
    if (ready) return ready;
    await sleep(1500);
  }
  const late = await findFileByExactFilename(storeDomain, accessToken, filename);
  return late[0] || null;
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

async function main() {
  const apply = process.argv.includes("--apply");
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }

  ensureConfigDir();
  if (!fs.existsSync(NEW_FOLDER)) {
    throw new Error(`Folder not found: ${NEW_FOLDER}`);
  }

  const localFiles = fs
    .readdirSync(NEW_FOLDER, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(jpe?g|png|webp)$/i.test(e.name))
    .map((e) => e.name)
    .sort();

  console.log(`Store: ${credentials.storeDomain}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Folder: ${NEW_FOLDER}`);
  console.log(`Local images: ${localFiles.length}`);
  console.log(`Mapped: ${Object.keys(NEW_FILE_MAP).length}`);
  console.log("");

  const results = [];
  let planned = 0;
  let replaced = 0;
  let created = 0;
  let assigned = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < localFiles.length; i += 1) {
    const localName = localFiles[i];
    const mapping = NEW_FILE_MAP[localName];
    process.stdout.write(`[${i + 1}/${localFiles.length}] ${localName}… `);

    if (!mapping) {
      skipped += 1;
      console.log("SKIP: not in NEW_FILE_MAP");
      results.push({ localName, status: "skipped-unmapped" });
      continue;
    }

    const localPath = path.join(NEW_FOLDER, localName);
    const { handle, shopifyFilename } = mapping;

    try {
      const collection = await fetchCollectionByHandle(
        credentials.storeDomain,
        credentials.accessToken,
        handle
      );
      if (!collection?.id) {
        throw new Error(`Collection not found: ${handle}`);
      }

      const existing = await findFileByExactFilename(
        credentials.storeDomain,
        credentials.accessToken,
        shopifyFilename
      );
      const existingFile = existing[0] || null;
      const fileAction = existingFile ? "replace" : "create";

      const entry = {
        localName,
        localPath,
        handle,
        title: collection.title,
        collectionId: collection.id,
        shopifyFilename,
        fileAction,
        oldImageUrl: collection.image?.url || "",
        oldWidth: collection.image?.width || null,
        oldHeight: collection.image?.height || null,
        existingFileId: existingFile?.id || null,
      };

      if (!apply) {
        planned += 1;
        console.log(
          `PLAN ${fileAction} ${shopifyFilename} → ${handle} (${collection.title})`
        );
        results.push({ ...entry, status: "planned" });
        continue;
      }

      const staged = await stagedUploadAsFile(
        credentials.storeDomain,
        credentials.accessToken,
        localPath,
        shopifyFilename
      );

      if (existingFile) {
        await fileUpdateContent(
          credentials.storeDomain,
          credentials.accessToken,
          existingFile.id,
          staged.resourceUrl
        );
        replaced += 1;
      } else {
        await fileCreate(
          credentials.storeDomain,
          credentials.accessToken,
          staged.resourceUrl,
          shopifyFilename,
          collection.title
        );
        created += 1;
      }

      const ready = await waitForFile(
        credentials.storeDomain,
        credentials.accessToken,
        shopifyFilename
      );
      if (!ready?.url) {
        throw new Error(`File not ready after upload: ${shopifyFilename}`);
      }

      await updateCollectionImage(
        credentials.storeDomain,
        credentials.accessToken,
        collection.id,
        ready.url
      );
      await sleep(1000);

      const refreshed = await fetchCollectionByHandle(
        credentials.storeDomain,
        credentials.accessToken,
        handle
      );
      assigned += 1;
      const rw = Number(refreshed?.image?.width) || 0;
      const rh = Number(refreshed?.image?.height) || 0;
      const verifiedUrl = refreshed?.image?.url || "";
      console.log(
        `${fileAction.toUpperCase()}+ASSIGN ${handle} → ${rw || "?"}x${rh || "?"} (${shopifyFilename})`
      );
      results.push({
        ...entry,
        status: "updated",
        fileUrl: ready.url,
        fileWidth: ready.width,
        fileHeight: ready.height,
        verifiedUrl,
        verifiedWidth: rw || null,
        verifiedHeight: rh || null,
      });
    } catch (error) {
      errors += 1;
      console.log(`ERROR: ${error.message || error}`);
      results.push({
        localName,
        handle: mapping.handle,
        shopifyFilename: mapping.shopifyFilename,
        status: "error",
        reason: error.message || String(error),
      });
    }
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    localCount: localFiles.length,
    mapped: Object.keys(NEW_FILE_MAP).length,
    planned,
    replaced,
    created,
    assigned,
    skipped,
    errors,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify({ summary, results }, null, 2), "utf8");

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`Local: ${summary.localCount}`);
  if (apply) {
    console.log(`Replaced Files: ${summary.replaced}`);
    console.log(`Created Files: ${summary.created}`);
    console.log(`Assigned collections: ${summary.assigned}`);
  } else {
    console.log(`Planned: ${summary.planned}`);
  }
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Errors: ${summary.errors}`);
  console.log(`Report: ${REPORT_PATH}`);

  if (!apply) {
    console.log("");
    console.log("Dry-run complete. Re-run with --apply to replace Files and assign collections.");
  }

  if (apply && summary.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
