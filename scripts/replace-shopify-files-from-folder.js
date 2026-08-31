#!/usr/bin/env node
/**
 * Replace Shopify Files content with local images matched by exact filename.
 * Keeps the Shopify filename the same (fileUpdate originalSource only).
 *
 * Usage:
 *   node scripts/replace-shopify-files-from-folder.js
 *   node scripts/replace-shopify-files-from-folder.js --apply
 *   node scripts/replace-shopify-files-from-folder.js --folder="D:\path" --apply
 *
 * Default folder: C:\Users\divya\Downloads\Collection Images
 * Report: ~/.editpro/replace-shopify-files-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const { mimeTypeForPath } = require("../lib/shopify-staged-upload");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(CONFIG_DIR, "replace-shopify-files-report.json");
const DEFAULT_FOLDER = "C:\\Users\\divya\\Downloads\\Collection Images";
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  let folder = DEFAULT_FOLDER;
  for (const arg of argv) {
    if (arg.startsWith("--folder=")) {
      folder = arg.slice("--folder=".length).trim().replace(/^["']|["']$/g, "");
    }
  }
  return { apply, folder };
}

function listLocalImages(folder) {
  if (!fs.existsSync(folder)) {
    throw new Error(`Folder not found: ${folder}`);
  }
  const files = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    files.push({
      filename: entry.name,
      localPath: path.join(folder, entry.name),
      size: fs.statSync(path.join(folder, entry.name)).size,
    });
  }
  files.sort((a, b) => a.filename.localeCompare(b.filename));
  return files;
}

function normalizeFilename(name) {
  return String(name || "").trim().toLowerCase();
}

async function findShopifyFileByFilename(storeDomain, accessToken, filename) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query FilesByFilename($query: String!) {
      files(first: 10, query: $query) {
        nodes {
          id
          fileStatus
          alt
          ... on MediaImage {
            id
            mimeType
            image { url }
            originalSource { url }
          }
          ... on GenericFile {
            id
            mimeType
            url
            originalFileSize
          }
        }
      }
    }`,
    { query: `filename:${filename}` }
  );

  const nodes = data.files?.nodes || [];
  const targetName = normalizeFilename(filename);
  const exact = [];

  for (const node of nodes) {
    const url = node.image?.url || node.url || node.originalSource?.url || "";
    let nodeFilename = "";
    try {
      nodeFilename = path.basename(new URL(url).pathname);
    } catch {
      nodeFilename = "";
    }
    // Some APIs expose filename via URL path only; also accept query hit without URL parse
    if (nodeFilename && normalizeFilename(nodeFilename) === targetName) {
      exact.push({
        id: node.id,
        fileStatus: node.fileStatus || "",
        url,
        mimeType: node.mimeType || "",
        alt: node.alt || "",
        filename: nodeFilename,
      });
    }
  }

  // Fallback: if query returned a single READY file, use it even if URL basename differs slightly
  if (!exact.length && nodes.length === 1) {
    const node = nodes[0];
    const url = node.image?.url || node.url || "";
    exact.push({
      id: node.id,
      fileStatus: node.fileStatus || "",
      url,
      mimeType: node.mimeType || "",
      alt: node.alt || "",
      filename,
    });
  }

  if (!exact.length) {
    return { match: null, reason: "No Shopify file with this filename." };
  }

  const ready = exact.filter((f) => !f.fileStatus || f.fileStatus === "READY");
  const candidates = ready.length ? ready : exact;
  if (candidates.length > 1) {
    return {
      match: null,
      reason: `Ambiguous: ${candidates.length} Shopify files matched filename.`,
      candidates,
    };
  }
  return { match: candidates[0], reason: "" };
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
    throw new Error(`Staged upload failed (${uploadResponse.status}): ${text.slice(0, 200)}`);
  }

  return { resourceUrl: target.resourceUrl, filename, mimeType };
}

async function replaceFileContent(storeDomain, accessToken, fileId, resourceUrl) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation FileUpdate($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage {
            image { url }
          }
          ... on GenericFile {
            url
          }
        }
        userErrors { field message code }
      }
    }`,
    {
      files: [
        {
          id: fileId,
          originalSource: resourceUrl,
        },
      ],
    }
  );
  const errors = data.fileUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.fileUpdate?.files?.[0] || null;
}

async function main() {
  const { apply, folder } = parseArgs(process.argv.slice(2));
  const credentials = getShopifyCredentials();
  if (!credentials.storeDomain || !credentials.accessToken) {
    throw new Error("Shopify is not connected. Add credentials in EditPro Settings.");
  }

  ensureConfigDir();
  const locals = listLocalImages(folder);
  console.log(`Store: ${credentials.storeDomain}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Folder: ${folder}`);
  console.log(`Local images: ${locals.length}`);
  console.log("");

  const results = [];
  let matched = 0;
  let missing = 0;
  let updated = 0;
  let errors = 0;

  for (let i = 0; i < locals.length; i += 1) {
    const local = locals[i];
    process.stdout.write(`[${i + 1}/${locals.length}] ${local.filename}… `);

    try {
      const found = await findShopifyFileByFilename(
        credentials.storeDomain,
        credentials.accessToken,
        local.filename
      );

      if (!found.match) {
        missing += 1;
        console.log(`SKIP: ${found.reason}`);
        results.push({
          filename: local.filename,
          localPath: local.localPath,
          status: "missing",
          reason: found.reason,
        });
        continue;
      }

      matched += 1;
      const entry = {
        filename: local.filename,
        localPath: local.localPath,
        localSize: local.size,
        shopifyFileId: found.match.id,
        shopifyUrl: found.match.url,
        shopifyStatus: found.match.fileStatus,
        status: "matched",
      };

      if (!apply) {
        console.log(`MATCH ${found.match.id}`);
        results.push(entry);
        continue;
      }

      const staged = await stagedUploadAsFile(
        credentials.storeDomain,
        credentials.accessToken,
        local.localPath,
        local.filename
      );
      const updatedFile = await replaceFileContent(
        credentials.storeDomain,
        credentials.accessToken,
        found.match.id,
        staged.resourceUrl
      );

      updated += 1;
      entry.status = "updated";
      entry.newFileStatus = updatedFile?.fileStatus || "";
      entry.newUrl = updatedFile?.image?.url || updatedFile?.url || found.match.url;
      console.log(`UPDATED (${entry.newFileStatus || "ok"})`);
      results.push(entry);
    } catch (error) {
      errors += 1;
      console.log(`ERROR: ${error.message || error}`);
      results.push({
        filename: local.filename,
        localPath: local.localPath,
        status: "error",
        reason: error.message || String(error),
      });
    }
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    folder,
    localCount: locals.length,
    matched,
    missing,
    updated,
    errors,
  };

  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify({ summary, results }, null, 2),
    "utf8"
  );

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`Local images: ${summary.localCount}`);
  console.log(`Matched on Shopify: ${summary.matched}`);
  console.log(`Missing on Shopify: ${summary.missing}`);
  if (apply) {
    console.log(`Updated: ${summary.updated}`);
    console.log(`Errors: ${summary.errors}`);
  }
  console.log(`Report: ${REPORT_PATH}`);

  if (!apply) {
    console.log("");
    console.log("Dry-run complete. Re-run with --apply to replace file content.");
  }

  if (apply && summary.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
