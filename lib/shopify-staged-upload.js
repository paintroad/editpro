const fs = require("fs");
const path = require("path");
const { shopifyGraphql } = require("./shopify-client");

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  return "image/jpeg";
}

async function stagedUploadFile(storeDomain, accessToken, localPath) {
  const filename = path.basename(localPath);
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
          resource: "PRODUCT_IMAGE",
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
  if (!target?.url) {
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
    throw new Error(`Image upload failed (${uploadResponse.status}): ${text.slice(0, 200)}`);
  }

  return {
    resourceUrl: target.resourceUrl,
    filename,
    alt: "",
  };
}

module.exports = {
  mimeTypeForPath,
  stagedUploadFile,
};
