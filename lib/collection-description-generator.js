const fs = require("fs");
const sharp = require("sharp");
const { getOpenAiApiKey, loadConfig } = require("./config-store");
const { wrapDescriptionHtml } = require("./catalog-text-utils");
const { stripHtml } = require("./collection-rules-apply");

async function loadImageBufferFromPath(localPath, options = {}) {
  const maxWidth = options.imageMaxWidth || 512;
  const buffer = await sharp(fs.readFileSync(localPath))
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return buffer;
}

async function downloadImageBuffer(imageUrl, options = {}) {
  const maxWidth = options.imageMaxWidth || 512;
  const response = await fetch(String(imageUrl), {
    signal: AbortSignal.timeout(options.timeoutMs || 60000),
  });
  if (!response.ok) {
    throw new Error(`Failed to download image (${response.status}).`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return sharp(Buffer.from(arrayBuffer))
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function buildDescriptionPrompt(collectionName, examples) {
  const exampleText = (examples || [])
    .map((example, index) => {
      const plain = stripHtml(example.descriptionHtml || "");
      return `Example ${index + 1} (${example.title || "Collection"}):\n${plain}`;
    })
    .join("\n\n");

  return `You write Shopify collection page descriptions for an online art store.

Collection name: ${collectionName}

Study these existing live collection descriptions and match their tone, structure, and level of detail:

${exampleText || "No examples available. Write a concise, inviting collection description for art prints."}

Write a new collection description for "${collectionName}" based on the attached collection image.
Return JSON: { "description": "plain text paragraph(s), no HTML" }`;
}

async function generateCollectionDescription({
  collectionName,
  imageUrl,
  imagePath,
  examples = [],
  openaiApiKey,
  openaiModel,
  openaiDetail,
  requestTimeoutMs,
}) {
  const config = loadConfig();
  const apiKey = (openaiApiKey || getOpenAiApiKey() || "").trim();
  if (!apiKey) {
    throw new Error("OpenAI API key is not configured.");
  }

  const model = openaiModel || config.roomDetection?.openaiModel || "gpt-4o";
  const detail = openaiDetail || config.roomDetection?.openaiDetail || "low";
  const timeoutMs = requestTimeoutMs || 90000;

  let imageBase64;
  if (imagePath && fs.existsSync(imagePath)) {
    imageBase64 = (await loadImageBufferFromPath(imagePath, { imageMaxWidth: 512, timeoutMs })).toString(
      "base64"
    );
  } else if (imageUrl) {
    imageBase64 = (await downloadImageBuffer(imageUrl, { imageMaxWidth: 512, timeoutMs })).toString(
      "base64"
    );
  } else {
    throw new Error("Collection image path or URL is required.");
  }

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildDescriptionPrompt(collectionName, examples) },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`,
                  detail,
                },
              },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw new Error(`Cannot reach OpenAI API. ${error.message || "Check your network connection."}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed (${response.status}). ${text.slice(0, 200)}`);
  }

  const payload = await response.json();
  const raw = payload.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OpenAI returned invalid JSON for collection description.");
  }

  const descriptionPlain = String(parsed.description || "").trim();
  if (!descriptionPlain) {
    throw new Error("OpenAI returned an empty collection description.");
  }

  return {
    descriptionPlain,
    descriptionHtml: wrapDescriptionHtml(descriptionPlain),
  };
}

module.exports = {
  generateCollectionDescription,
  loadImageBufferFromPath,
};
