const fs = require("fs");
const { getOpenAiApiKey } = require("./config-store");
const {
  truncate,
  slugify,
  wrapDescriptionHtml,
  buildSeoTitle,
  buildSeoDescription,
} = require("./catalog-text-utils");
const {
  buildVariants,
  minVariantPrice,
  normalizeShape,
  DEFAULT_METAFIELDS,
  PRODUCT_DEFAULTS,
} = require("./catalog-variant-templates");
const { ensureUniqueTitle, hasCatalogGeometry } = require("./catalog-products-store");

function buildOpenAiOptions(options) {
  const apiKey = (options.openaiApiKey || getOpenAiApiKey() || "").trim();
  const model = options.openaiModel || "gpt-4o";
  const detail = options.openaiDetail || "low";
  const timeoutMs = options.requestTimeoutMs || 90000;
  return { apiKey, model, detail, timeoutMs };
}

function readLocalImageBase64(localPath, maxBytes = 2 * 1024 * 1024) {
  const stat = fs.statSync(localPath);
  if (stat.size > maxBytes) {
    throw new Error(`Cached image too large (${Math.round(stat.size / 1024)} KB).`);
  }
  return fs.readFileSync(localPath).toString("base64");
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((v) => String(v || "").trim()).filter(Boolean);
}

function parseEnrichmentResponse(raw, { includeShape = true } = {}) {
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("OpenAI returned invalid JSON for product enrichment.");
  }

  const title = String(data.title || "").trim();
  const description = String(data.description || "").trim();
  const colors = normalizeStringArray(data.colors);
  const tags = normalizeStringArray(data.tags);

  const mf = data.metafields && typeof data.metafields === "object" ? data.metafields : {};
  const color = normalizeStringArray(mf.color);
  const theme = normalizeStringArray(mf.theme);

  if (!title) {
    throw new Error("OpenAI response missing title.");
  }
  if (!description) {
    throw new Error("OpenAI response missing description.");
  }
  if (tags.length < 10) {
    throw new Error(`OpenAI returned only ${tags.length} tags (need at least 10).`);
  }

  const result = {
    title,
    description,
    colors,
    tags,
    metafields: {
      color,
      theme,
      artworkFrameMaterial: [...DEFAULT_METAFIELDS.artworkFrameMaterial],
      frameStyle: [...DEFAULT_METAFIELDS.frameStyle],
      searchProductBoosts: String(mf.searchProductBoosts || "").trim(),
    },
  };

  if (includeShape) {
    result.shape = normalizeShape(data.shape);
  }

  return result;
}

function buildEnrichmentPrompt({ includeShape = true } = {}) {
  let prompt =
    "You are cataloging wall art for an online store (Paint Road). " +
    "Analyze this artwork image and return JSON with these fields:\n" +
    '- "title": unique descriptive product title (no quotes)\n' +
    '- "description": 2-4 sentence product description in the style of fine art ecommerce copy\n';
  if (includeShape) {
    prompt +=
      '- "shape": one of "square", "rectangle", or "circle" (circle counts as square for sizing)\n';
  }
  prompt +=
    '- "colors": array of dominant colors (e.g. ["pink", "blue", "white"])\n' +
    '- "tags": array of 20-30 lowercase tags including subject, style, mood, and rooms where this art fits best ' +
    '(e.g. living room, bedroom, dining room, office, hallway)\n' +
    '- "metafields": { "color": [...], "theme": [...] } using Shopify-style values like floral, blue, red, pink, ' +
    "art, modern, animals, sea-ocean, nature\n" +
    "Return only valid JSON.";
  return prompt;
}

async function enrichProductFromBase64(imageBase64, productId, options = {}, store, product = null) {
  const { apiKey, model, detail, timeoutMs } = buildOpenAiOptions(options);
  if (!apiKey) {
    throw new Error(
      "OpenAI API key is not configured. Set OPENAI_API_KEY or save a key in Room Map settings."
    );
  }

  const existingProduct = product || store?.products?.[productId] || null;
  const preserveGeometry = hasCatalogGeometry(existingProduct);
  const prompt = buildEnrichmentPrompt({ includeShape: !preserveGeometry });

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
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
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
    const err = new Error(`OpenAI request failed (${response.status}). ${text.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const parsed = parseEnrichmentResponse(content, { includeShape: !preserveGeometry });

  const title = ensureUniqueTitle(parsed.title, productId, store);
  const handle = slugify(title);
  const descriptionPlain = parsed.description;
  const shapeForVariants = preserveGeometry ? existingProduct.shape : parsed.shape;
  const variants = buildVariants(productId, shapeForVariants);
  const minPrice = minVariantPrice(variants);

  const result = {
    title,
    handle,
    descriptionPlain,
    descriptionHtml: wrapDescriptionHtml(descriptionPlain),
    description160: truncate(descriptionPlain, 160),
    description100: truncate(descriptionPlain, 100),
    colors: parsed.colors,
    tags: parsed.tags,
    metafields: parsed.metafields,
    variants,
    vendor: PRODUCT_DEFAULTS.vendor,
    productType: PRODUCT_DEFAULTS.productType,
    productCategory: PRODUCT_DEFAULTS.productCategory,
    seoTitle: buildSeoTitle(title),
    seoDescription: buildSeoDescription(title, minPrice),
    status: "enriched",
    enrichedAt: new Date().toISOString(),
    error: null,
  };

  if (!preserveGeometry && parsed.shape) {
    result.shape = parsed.shape;
  }

  return result;
}

async function enrichProductFromFile(localPath, productId, options = {}, store, product = null) {
  const imageBase64 = readLocalImageBase64(localPath, options.maxDownloadBytes || 2 * 1024 * 1024);
  const existingProduct = product || store?.products?.[productId] || null;
  return enrichProductFromBase64(imageBase64, productId, options, store, existingProduct);
}

module.exports = {
  enrichProductFromFile,
  enrichProductFromBase64,
  parseEnrichmentResponse,
  buildEnrichmentPrompt,
};
