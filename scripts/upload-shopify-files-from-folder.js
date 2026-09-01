#!/usr/bin/env node
/**
 * Upload local images to Shopify Files with exact filenames (fileCreate).
 * Skips files that already exist on Shopify. Flat Files root only.
 *
 * Usage:
 *   node scripts/upload-shopify-files-from-folder.js
 *   node scripts/upload-shopify-files-from-folder.js --apply
 *   node scripts/upload-shopify-files-from-folder.js --folder="C:\\Users\\divya\\Downloads\\Deprecated" --apply
 *
 * Report: ~/.editpro/upload-shopify-files-report.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { getShopifyCredentials } = require("../lib/config-store");
const { shopifyGraphql } = require("../lib/shopify-client");
const { mimeTypeForPath } = require("../lib/shopify-staged-upload");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const REPORT_PATH = path.join(CONFIG_DIR, "upload-shopify-files-report.json");
const DEFAULT_FOLDER = "C:\\Users\\divya\\Downloads\\Deprecated";
const CDN_PREFIX =
  "https://cdn.shopify.com/s/files/1/0694/3496/6165/files/";
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
          ... on MediaImage {
            image { url }
            originalSource { url }
          }
          ... on GenericFile {
            url
          }
        }
      }
    }`,
    { query: `filename:${filename}` }
  );

  const nodes = data.files?.nodes || [];
  const targetName = normalizeFilename(filename);
  for (const node of nodes) {
    const url = node.image?.url || node.url || node.originalSource?.url || "";
    let nodeFilename = "";
    try {
      nodeFilename = path.basename(new URL(url).pathname);
    } catch {
      nodeFilename = "";
    }
    if (nodeFilename && normalizeFilename(nodeFilename) === targetName) {
      return { match: { id: node.id, url, fileStatus: node.fileStatus || "" } };
    }
  }
  if (nodes.length === 1) {
    const node = nodes[0];
    return {
      match: {
        id: node.id,
        url: node.image?.url || node.url || "",
        fileStatus: node.fileStatus || "",
      },
    };
  }
  return { match: null };
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

async function fileCreate(storeDomain, accessToken, resourceUrl, filename) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation FileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
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
          originalSource: resourceUrl,
          filename,
          contentType: "IMAGE",
          alt: filename,
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

function cdnHeadStatus(filename) {
  const url = `${CDN_PREFIX}${encodeURIComponent(filename).replace(/%2F/g, "/")}`;
  try {
    const code = execFileSync(
      "curl.exe",
      ["-sI", "-o", "NUL", "-w", "%{http_code}", "--max-time", "25", url],
      { encoding: "utf8" }
    ).trim();
    return { url, status: Number(code) || 0 };
  } catch {
    return { url, status: 0 };
  }
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
  let skipped = 0;
  let uploaded = 0;
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

      if (found.match) {
        skipped += 1;
        console.log(`SKIP exists (${found.match.fileStatus || "READY"})`);
        results.push({
          filename: local.filename,
          status: "skipped",
          shopifyFileId: found.match.id,
          shopifyUrl: found.match.url,
        });
        await sleep(150);
        continue;
      }

      if (!apply) {
        console.log("WOULD UPLOAD");
        results.push({ filename: local.filename, status: "planned" });
        continue;
      }

      const staged = await stagedUploadAsFile(
        credentials.storeDomain,
        credentials.accessToken,
        local.localPath,
        local.filename
      );
      const created = await fileCreate(
        credentials.storeDomain,
        credentials.accessToken,
        staged.resourceUrl,
        local.filename
      );

      uploaded += 1;
      const createdUrl = created?.image?.url || created?.url || "";
      console.log(`UPLOADED (${created?.fileStatus || "ok"})`);
      results.push({
        filename: local.filename,
        status: "uploaded",
        shopifyFileId: created?.id || "",
        shopifyUrl: createdUrl,
        fileStatus: created?.fileStatus || "",
      });
      await sleep(400);
    } catch (error) {
      errors += 1;
      console.log(`ERROR: ${error.message || error}`);
      results.push({
        filename: local.filename,
        status: "error",
        reason: error.message || String(error),
      });
      await sleep(500);
    }
  }

  console.log("");
  console.log("CDN verification (sample of uploaded + previously broken)…");
  const toVerify = results
    .filter((r) => r.status === "uploaded" || r.status === "planned")
    .map((r) => r.filename);
  const cdnChecks = [];
  for (const filename of toVerify) {
    const check = cdnHeadStatus(filename);
    cdnChecks.push({ filename, ...check, ok: check.status === 200 });
    if (cdnChecks.length % 25 === 0) {
      process.stdout.write(`  verified ${cdnChecks.length}/${toVerify.length}\r`);
    }
    await sleep(50);
  }
  if (toVerify.length) {
    console.log(`  verified ${cdnChecks.length}/${toVerify.length}`);
  }

  const cdnOk = cdnChecks.filter((c) => c.ok).length;
  const cdnFail = cdnChecks.filter((c) => !c.ok).length;

  const summary = {
    mode: apply ? "apply" : "dry-run",
    folder,
    localCount: locals.length,
    skipped,
    uploaded,
    errors,
    cdnChecked: cdnChecks.length,
    cdnOk,
    cdnFail,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify({ summary, results, cdnChecks }, null, 2),
    "utf8"
  );

  const txtReport = path.join(folder, "shopify-upload-report.txt");
  const txtLines = [
    "Shopify Files upload report",
    `Generated: ${summary.generatedAt}`,
    `Mode: ${summary.mode}`,
    `Uploaded: ${summary.uploaded}`,
    `Skipped (already exists): ${summary.skipped}`,
    `Errors: ${summary.errors}`,
    `CDN OK after upload: ${summary.cdnOk}/${summary.cdnChecked}`,
    "",
    "filename\tstatus\tshopifyUrl",
    ...results.map(
      (r) => `${r.filename}\t${r.status}\t${r.shopifyUrl || r.reason || ""}`
    ),
  ];
  fs.writeFileSync(txtReport, txtLines.join("\n"), "utf8");

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`JSON report: ${REPORT_PATH}`);
  console.log(`Text report: ${txtReport}`);

  if (!apply) {
    console.log("");
    console.log("Dry-run complete. Re-run with --apply to upload.");
  }

  if (errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
