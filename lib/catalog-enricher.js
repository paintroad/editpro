const { getOpenAiApiKey } = require("./config-store");
const { openAiImageBuffer } = require("./openai-image");
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
  applyProductDefaults,
} = require("./catalog-variant-templates");
const { ensureUniqueTitle, isTitleTaken, hasCatalogGeometry } = require("./catalog-products-store");
const { ROOM_TAGS, STYLE_TAGS, filterAllowedTags } = require("./collection-tag-allowlist");
const { omitBathroomRoomForDeity } = require("./deity-bathroom");
const { findBlocked, assertClean } = require("./brand-guard");
const { referenceFor } = require("./catalog-reference");
const { withoutDeityVastu } = require("./catalog-collections");

function buildOpenAiOptions(options) {
  const apiKey = (options.openaiApiKey || getOpenAiApiKey() || "").trim();
  const model = options.openaiModel || "gpt-4o";
  const detail = options.openaiDetail || "low";
  const timeoutMs = options.requestTimeoutMs || 90000;
  return { apiKey, model, detail, timeoutMs };
}

async function readLocalImageBase64(localPath, options = {}) {
  const maxWidth = options.imageMaxWidth || 512;
  const maxBytes = options.maxDownloadBytes || 2 * 1024 * 1024;
  const buffer = await openAiImageBuffer(localPath, { maxWidth });
  if (buffer.length > maxBytes) {
    throw new Error(`Cached image too large (${Math.round(buffer.length / 1024)} KB).`);
  }
  return buffer.toString("base64");
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

  const styleTags = filterAllowedTags(data.styleTags, STYLE_TAGS);
  const roomTags = filterAllowedTags(data.roomTags, ROOM_TAGS);
  if (!styleTags.length) {
    throw new Error("OpenAI did not return an allowed style collection tag.");
  }
  if (!roomTags.length) {
    throw new Error("OpenAI did not return an allowed room collection tag.");
  }
  const mergedTags = [...tags];
  for (const tag of [...styleTags, ...roomTags]) {
    if (!mergedTags.some((existing) => existing === tag)) {
      mergedTags.push(tag);
    }
  }
  const deitySafe = omitBathroomRoomForDeity(styleTags, roomTags, mergedTags);

  const result = {
    title,
    description,
    colors,
    tags: deitySafe.tags,
    styleTags: deitySafe.styleTags,
    roomTags: deitySafe.roomTags,
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

function buildEnrichmentPrompt({ includeShape = true, reference = null } = {}) {
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
    '- "styleTags": one or more exact strings from this style list, copied character for character. ' +
    "A painting may belong to several styles. Do not invent tags and do not use artist names: " +
    JSON.stringify(STYLE_TAGS) +
    "\n" +
    '- "roomTags": at least one exact string from this room list, copied character for character: ' +
    JSON.stringify(ROOM_TAGS) +
    "\n" +
    "If the artwork depicts a god, goddess, or lord (including Hanuman, Krishna, Radha, Shiva, Vishnu, Ganesha, Durga, Lakshmi, or Buddha), do not use bathroom in roomTags or tags.\n" +
    '- "metafields": { "color": [...], "theme": [...] } using Shopify-style values like floral, blue, red, pink, ' +
    "art, modern, animals, sea-ocean, nature\n" +
    "Return only valid JSON.";
  return prompt + referencePrompt(reference);
}

function listingBlock(item) {
  return [
    `Title: ${item.title}`,
    item.type ? `Type: ${item.type}` : "",
    item.tags.length ? `Tags: ${item.tags.join(", ")}` : "",
    item.description ? `Description: ${item.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function referencePrompt(reference) {
  if (!reference) return "";
  const parts = [];
  if (reference.categories.length || reference.folder) {
    const saved = [...reference.categories, reference.folder].filter(Boolean).join(" > ");
    parts.push(
      `Our catalog filed this artwork under: ${saved}. Reflect this art form and subject in the title, description and tags.`
    );
  }
  if (reference.styleTags.length) {
    parts.push(`These style tags will be applied from our catalog: ${JSON.stringify(reference.styleTags)}. Add more only if they clearly fit.`);
  }
  if (reference.match) {
    parts.push(`A leading Indian art store lists this same artwork as:\n${listingBlock(reference.match)}`);
  }
  if (reference.examples.length) {
    parts.push(
      `How leading Indian art stores list similar artworks:\n${reference.examples.map(listingBlock).join("\n---\n")}`
    );
  }
  if (reference.patterns.length) {
    parts.push(`Title patterns leading Indian art stores use by art form:\n- ${reference.patterns.join("\n- ")}`);
  }
  if (!parts.length) return "";
  return (
    "\n\nMarket research (use it, do not copy it):\n" +
    parts.join("\n\n") +
    "\n\nUse the research to name the art form, subject and story the way shoppers search for them, and to pick the keywords " +
    "that help this listing rank. When the art form is known (Pichwai, Gond, Warli, ...), name it in the title. Write an original title and description in Paint Road's voice: never copy a title or a sentence. " +
    "Paint Road sells fine-art prints, framed and unframed, so never call it hand-painted, an original, or give sizes or prices. " +
    "Never mention any brand, store, seller or website name. Ignore internal tags such as \"Needs Size and Price\"."
  );
}

function similarTitles(productId, reference, store, limit = 60) {
  const forms = (reference?.styleTags || []).slice(0, 2).map((tag) => String(tag).toLowerCase());
  if (!forms.length || !store?.products) return [];
  const titles = [];
  for (const p of Object.values(store.products)) {
    if (p.productId === productId || !p.title) continue;
    const tags = (p.styleTags || []).map((tag) => String(tag).toLowerCase());
    if (forms.some((form) => tags.includes(form))) titles.push(p.title);
  }
  return titles.slice(-limit);
}

function takenTitlesPrompt(titles) {
  if (!titles.length) return "";
  return (
    "\n\nThese titles are already used by other paintings in our catalog. Write a clearly different title that names what is distinctive in this painting (its main figures, animals, scene, colours or composition):\n- " +
    titles.join("\n- ")
  );
}

function referenceProblem(parsed, reference, productId, store) {
  const hits = findBlocked({ title: parsed.title, description: parsed.description, tags: parsed.tags, metafields: parsed.metafields });
  if (hits.length) return `it named a competitor (${hits[0].term})`;
  if (store && isTitleTaken(parsed.title, productId, store)) {
    return `the title "${parsed.title}" is already used by another painting`;
  }
  const theirs = String(reference?.match?.title || "").toLowerCase().replace(/\W+/g, " ").trim();
  if (theirs && String(parsed.title).toLowerCase().replace(/\W+/g, " ").trim() === theirs) {
    return "the title copied the reference listing";
  }
  return null;
}

function mergeStyleTags(parsed, styleTags) {
  for (const tag of styleTags || []) {
    if (!parsed.styleTags.includes(tag)) parsed.styleTags.push(tag);
    if (!parsed.tags.includes(tag)) parsed.tags.push(tag);
  }
  const deitySafe = omitBathroomRoomForDeity(parsed.styleTags, parsed.roomTags, parsed.tags);
  const deity = withoutDeityVastu([...deitySafe.styleTags, ...deitySafe.tags]).length !==
    deitySafe.styleTags.length + deitySafe.tags.length;
  parsed.styleTags = deity ? deitySafe.styleTags.filter((tag) => !/^vastu$/i.test(tag)) : deitySafe.styleTags;
  parsed.roomTags = deitySafe.roomTags;
  parsed.tags = deity ? deitySafe.tags.filter((tag) => !/^vastu$/i.test(tag)) : deitySafe.tags;
  return parsed;
}

async function requestEnrichment(prompt, imageBase64, { apiKey, model, detail, timeoutMs }) {
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
        max_tokens: 2000,
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
  return data?.choices?.[0]?.message?.content || "";
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
  const reference = options.useReference === false ? null : await referenceFor(productId);
  const basePrompt =
    buildEnrichmentPrompt({ includeShape: !preserveGeometry, reference }) +
    takenTitlesPrompt(similarTitles(productId, reference, store));

  let parsed = null;
  let problem = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = problem
      ? `${basePrompt}\n\nYour previous answer was rejected because ${problem}. Try again.`
      : basePrompt;
    const content = await requestEnrichment(prompt, imageBase64, { apiKey, model, detail, timeoutMs });
    parsed = parseEnrichmentResponse(content, { includeShape: !preserveGeometry });
    problem = referenceProblem(parsed, reference, productId, store);
    if (!problem) break;
  }
  if (problem && /already used/.test(problem)) problem = null;
  if (problem) {
    throw new Error(`Enrichment rejected twice: ${problem}.`);
  }
  mergeStyleTags(parsed, reference?.styleTags);

  const title = ensureUniqueTitle(parsed.title, productId, store);
  const handle = slugify(title);
  const descriptionPlain = parsed.description;
  const shapeForVariants = preserveGeometry ? existingProduct.shape : parsed.shape;
  const variants = buildVariants(productId, shapeForVariants);
  const minPrice = minVariantPrice(variants);

  const result = applyProductDefaults({
    title,
    handle,
    descriptionPlain,
    descriptionHtml: wrapDescriptionHtml(descriptionPlain),
    description160: truncate(descriptionPlain, 160),
    description100: truncate(descriptionPlain, 100),
    colors: parsed.colors,
    tags: parsed.tags,
    styleTags: parsed.styleTags,
    roomTags: parsed.roomTags,
    metafields: parsed.metafields,
    variants,
    seoTitle: buildSeoTitle(title),
    seoDescription: buildSeoDescription(title, minPrice),
    status: "enriched",
    enrichedAt: new Date().toISOString(),
    error: null,
  });

  if (!preserveGeometry && parsed.shape) {
    result.shape = parsed.shape;
  }

  return assertClean(result, "enrichment");
}

async function enrichProductFromFile(localPath, productId, options = {}, store, product = null) {
  const imageBase64 = await readLocalImageBase64(localPath, options);
  const existingProduct = product || store?.products?.[productId] || null;
  return enrichProductFromBase64(imageBase64, productId, options, store, existingProduct);
}

module.exports = {
  enrichProductFromFile,
  enrichProductFromBase64,
  parseEnrichmentResponse,
  buildEnrichmentPrompt,
};
