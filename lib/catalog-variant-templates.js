const fs = require("fs");
const path = require("path");
const os = require("os");

/** Storefront / option value order. */
const SIZE_CODES = ["XS", "S", "M", "L", "XL"];
const CANVAS_SIZE_CODES = ["M", "L", "XL"];
const PAPER_SIZE_CODES = ["XS", "S"];

const REFERENCE_PATH = path.join(os.homedir(), ".editpro", "catalog-variant-reference.json");

const MATERIAL_CANVAS = "Canvas";
const MATERIAL_PAPER = "Fine Art Paper";
/** Default product metafield / taxonomy (Canvas first). */
const PRODUCT_MATERIAL = MATERIAL_CANVAS;

const SQUARE_SIZES = {
  XS: 'XS - 10"x10"',
  S: 'S - 12"x12"',
  M: 'M - 18"x18"',
  L: 'L - 24"x24"',
  XL: 'XL - 36"x36"',
};

const RECTANGLE_SIZES = {
  XS: 'XS - 8"x10"',
  S: 'S - 12"x16"',
  M: 'M - 18"x24"',
  L: 'L - 24"x36"',
  XL: 'XL - 36"x48"',
};

/**
 * Price/compareAt shared across frames at a size.
 * costStretched = Mayapuri (Canvas stretched only); costFramed = Naraina.
 * Paper / XS / S have no stretched cost.
 */
const SQUARE_PRICES = {
  XS: { price: 1099, compareAt: 1699, costFramed: 300 },
  S: { price: 1199, compareAt: 1999, costFramed: 400 },
  M: { price: 2999, compareAt: 4999, costStretched: 600, costFramed: 750 },
  L: { price: 4999, compareAt: 7999, costStretched: 1040, costFramed: 1350 },
  XL: { price: 8999, compareAt: 13999, costStretched: 2340, costFramed: 2500 },
};

const RECTANGLE_PRICES = {
  XS: { price: 1099, compareAt: 1699, costFramed: 300 },
  S: { price: 1199, compareAt: 1999, costFramed: 400 },
  M: { price: 3699, compareAt: 5999, costStretched: 780, costFramed: 1000 },
  L: { price: 5999, compareAt: 8999, costStretched: 1560, costFramed: 1750 },
  XL: { price: 9999, compareAt: 15999, costStretched: 3020, costFramed: 3500 },
};

/** Grams — same for all frames at a size. */
const SQUARE_WEIGHTS = {
  XS: 350,
  S: 500,
  M: 1000,
  L: 2000,
  XL: 3000,
};

const RECTANGLE_WEIGHTS = {
  XS: 400,
  S: 750,
  M: 1500,
  L: 2500,
  XL: 4000,
};

/** Canvas frames. SKU suffix `n` kept for marketplace continuity. Stretched last in UI. */
const VARIANT_ROWS_CANVAS = [
  { frame: "black", n: 5 },
  { frame: "white", n: 6 },
  { frame: "wooden", n: 7 },
  { frame: "dark-wood", n: 9 },
  { frame: "stretched-canvas", n: 4 },
];

/** Fine Art Paper — framed only (no stretched). */
const VARIANT_ROWS_PAPER = [
  { frame: "black", n: 1 },
  { frame: "white", n: 2 },
  { frame: "wooden", n: 3 },
  { frame: "dark-wood", n: 8 },
];

/** @deprecated alias — Canvas rows only. Prefer VARIANT_ROWS_CANVAS. */
const VARIANT_ROWS = VARIANT_ROWS_CANVAS;

const DEFAULT_METAFIELDS = {
  artworkFrameMaterial: ["wood", "plastic"],
  frameStyle: [
    "Black",
    "White",
    "Wooden",
    "Dark Brown",
    "Stretched Canvas",
  ],
  material: PRODUCT_MATERIAL,
};

const FRAME_DISPLAY_LABELS = {
  black: "Black",
  white: "White",
  wooden: "Wooden",
  "dark-wood": "Dark Brown",
  "stretched-canvas": "Stretched Canvas",
};

const PRODUCT_DEFAULTS = {
  vendor: "Paintroad",
  productType: "Painting",
  productCategory:
    "Home & Garden > Decor > Artwork > Posters, Prints, & Visual Artwork > Visual Artwork",
  productCategoryId: "gid://shopify/TaxonomyCategory/hg-3-4-2-3",
  templateSuffix: "product",
  salesChannels: ["Online Store", "Facebook & Instagram", "Inbox", "Google & YouTube"],
  countryOfOrigin: "IN",
  inventoryQty: 100,
  inventoryPolicy: "continue",
  fulfillmentService: "manual",
  requiresShipping: true,
  taxable: true,
  tracked: true,
  weightUnit: "g",
  status: "active",
  published: true,
};

let cachedReference = null;

function normalizeFrame(frame) {
  const f = String(frame || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  if (f === "black-frame") {
    return "black";
  }
  if (f === "wooden-finish") {
    return "wooden";
  }
  if (
    f === "dark-wood-finish" ||
    f === "darkwood" ||
    f === "dark-wood" ||
    f === "dark-brown"
  ) {
    return "dark-wood";
  }
  if (f === "stretchedcanvas") {
    return "stretched-canvas";
  }
  return f;
}

function normalizeMaterial(material) {
  const m = String(material || "")
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ");
  if (
    m.includes("paper") ||
    m === "fine-art-paper" ||
    m === "fine art paper"
  ) {
    return MATERIAL_PAPER;
  }
  return MATERIAL_CANVAS;
}

function isPaperMaterial(material) {
  return normalizeMaterial(material) === MATERIAL_PAPER;
}

function isStretchedFrame(frame) {
  return normalizeFrame(frame) === "stretched-canvas";
}

function frameDisplayLabel(frame) {
  const key = normalizeFrame(frame);
  return FRAME_DISPLAY_LABELS[key] || String(frame || "").trim();
}

function normalizeWeightUnit(unit) {
  const u = String(unit || "").toLowerCase();
  if (u === "grams" || u === "g") {
    return "g";
  }
  if (u === "kilograms" || u === "kg") {
    return "kg";
  }
  return u || PRODUCT_DEFAULTS.weightUnit;
}

function normalizeShape(shape) {
  const s = String(shape || "").toLowerCase().trim();
  if (s === "rectangle" || s === "rectangular") {
    return "rectangle";
  }
  if (s === "circle" || s === "circular") {
    return "square";
  }
  return "square";
}

function getTemplateForShape(shape) {
  const normalized = normalizeShape(shape);
  if (normalized === "rectangle") {
    return {
      sizes: RECTANGLE_SIZES,
      prices: RECTANGLE_PRICES,
      weights: RECTANGLE_WEIGHTS,
      shape: "rectangle",
    };
  }
  return {
    sizes: SQUARE_SIZES,
    prices: SQUARE_PRICES,
    weights: SQUARE_WEIGHTS,
    shape: "square",
  };
}

function sizeCodesForMaterial(material) {
  return isPaperMaterial(material) ? PAPER_SIZE_CODES : CANVAS_SIZE_CODES;
}

function variantRowsForMaterial(material) {
  return isPaperMaterial(material) ? VARIANT_ROWS_PAPER : VARIANT_ROWS_CANVAS;
}

function pricingForVariant(shape, sizeCode, material, frame) {
  const mat = normalizeMaterial(material);
  const { prices } = getTemplateForShape(shape);
  const priceRow = prices[sizeCode];
  if (!priceRow) {
    return null;
  }

  if (mat === MATERIAL_PAPER) {
    if (!PAPER_SIZE_CODES.includes(sizeCode)) {
      return null;
    }
    if (isStretchedFrame(frame)) {
      return null;
    }
    if (priceRow.costFramed == null) {
      return null;
    }
    return {
      price: priceRow.price,
      compareAt: priceRow.compareAt,
      cost: priceRow.costFramed,
    };
  }

  if (!CANVAS_SIZE_CODES.includes(sizeCode)) {
    return null;
  }
  const cost = isStretchedFrame(frame)
    ? priceRow.costStretched
    : priceRow.costFramed;
  if (cost == null) {
    return null;
  }
  return {
    price: priceRow.price,
    compareAt: priceRow.compareAt,
    cost,
  };
}

/**
 * Compat: pricingForVariant(shape, size, frame) → assume Canvas
 * or pricingForVariant(shape, size, material, frame).
 */
function pricingForVariantCompat(shape, sizeCode, materialOrFrame, maybeFrame) {
  if (maybeFrame !== undefined) {
    return pricingForVariant(shape, sizeCode, materialOrFrame, maybeFrame);
  }
  return pricingForVariant(shape, sizeCode, MATERIAL_CANVAS, materialOrFrame);
}

function weightForVariant(shape, sizeCode) {
  const { weights } = getTemplateForShape(shape);
  const w = weights[sizeCode];
  return w != null ? w : null;
}

function variantReferenceKey(shape, sizeCode, material, frame) {
  return `${normalizeShape(shape)}|${sizeCode}|${normalizeMaterial(material)}|${normalizeFrame(frame)}`;
}

function loadVariantReference() {
  if (cachedReference) {
    return cachedReference;
  }
  if (!fs.existsSync(REFERENCE_PATH)) {
    cachedReference = { rectangle: {}, square: {} };
    return cachedReference;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(REFERENCE_PATH, "utf8"));
    const normalizeTable = (table) => {
      const out = {};
      for (const [key, row] of Object.entries(table || {})) {
        const parts = key.split("|");
        if (parts.length === 4) {
          parts[2] = normalizeMaterial(parts[2]);
          parts[3] = normalizeFrame(parts[3]);
          out[parts.join("|")] = row;
        } else if (parts.length === 3) {
          parts[2] = normalizeFrame(parts[2]);
          out[`${parts[0]}|${parts[1]}|${MATERIAL_CANVAS}|${parts[2]}`] = row;
        } else {
          out[key] = row;
        }
      }
      return out;
    };
    cachedReference = {
      rectangle: normalizeTable(raw.rectangle?.variants),
      square: normalizeTable(raw.square?.variants),
    };
  } catch {
    cachedReference = { rectangle: {}, square: {} };
  }
  return cachedReference;
}

function getVariantReference(shape, sizeCode, materialOrFrame, maybeFrame) {
  const material =
    maybeFrame !== undefined
      ? normalizeMaterial(materialOrFrame)
      : MATERIAL_CANVAS;
  const frame =
    maybeFrame !== undefined ? maybeFrame : materialOrFrame;

  const ref = loadVariantReference();
  const normalizedShape = normalizeShape(shape);
  const frameKey = normalizeFrame(frame);
  const candidates = [frameKey];
  if (frameKey === "dark-wood") {
    candidates.push("wooden");
  }
  if (frameKey === "stretched-canvas") {
    candidates.push("wooden", "black");
  }

  for (const candidate of candidates) {
    const key = variantReferenceKey(
      normalizedShape,
      sizeCode,
      material,
      candidate
    );
    const direct = ref[normalizedShape]?.[key];
    if (direct) {
      return direct;
    }
    if (normalizedShape === "square") {
      const rect = ref.rectangle?.[key];
      if (rect) {
        return rect;
      }
    }
  }
  return null;
}

function applyProductDefaults(product) {
  if (!product || typeof product !== "object") {
    return product;
  }
  product.vendor = PRODUCT_DEFAULTS.vendor;
  product.productType = PRODUCT_DEFAULTS.productType;
  product.productCategory = PRODUCT_DEFAULTS.productCategory;
  product.productCategoryId = PRODUCT_DEFAULTS.productCategoryId;
  product.templateSuffix = PRODUCT_DEFAULTS.templateSuffix;
  product.salesChannels = [...PRODUCT_DEFAULTS.salesChannels];
  product.countryOfOrigin = PRODUCT_DEFAULTS.countryOfOrigin;
  product.material = PRODUCT_MATERIAL;
  if (!product.metafields || typeof product.metafields !== "object") {
    product.metafields = {};
  }
  product.metafields.material = PRODUCT_MATERIAL;
  if (!Array.isArray(product.metafields.artworkFrameMaterial)) {
    product.metafields.artworkFrameMaterial = [...DEFAULT_METAFIELDS.artworkFrameMaterial];
  }
  if (!Array.isArray(product.metafields.frameStyle) || !product.metafields.frameStyle.length) {
    product.metafields.frameStyle = [...DEFAULT_METAFIELDS.frameStyle];
  } else {
    const mapped = product.metafields.frameStyle.map((value) =>
      frameDisplayLabel(value)
    );
    const merged = [...DEFAULT_METAFIELDS.frameStyle];
    for (const label of mapped) {
      if (label && !merged.includes(label)) {
        merged.push(label);
      }
    }
    product.metafields.frameStyle = merged.filter(
      (label, idx, arr) => arr.indexOf(label) === idx
    );
  }
  return product;
}

function applyVariantDefaults(variant, shape) {
  const frameKey = normalizeFrame(variant.frame || variant.exportFrame);
  const material = normalizeMaterial(variant.material || PRODUCT_MATERIAL);
  const templatePricing = pricingForVariant(
    shape,
    variant.sizeCode,
    material,
    frameKey
  );
  const templateWeight = weightForVariant(shape, variant.sizeCode);

  const next = {
    ...variant,
    frame: frameKey,
    exportFrame: frameDisplayLabel(frameKey),
    material,
    inventoryQty: PRODUCT_DEFAULTS.inventoryQty,
    inventoryPolicy: PRODUCT_DEFAULTS.inventoryPolicy,
    fulfillmentService: PRODUCT_DEFAULTS.fulfillmentService,
    requiresShipping: PRODUCT_DEFAULTS.requiresShipping,
    taxable: PRODUCT_DEFAULTS.taxable,
    tracked: PRODUCT_DEFAULTS.tracked,
    countryOfOrigin: PRODUCT_DEFAULTS.countryOfOrigin,
    weightUnit: PRODUCT_DEFAULTS.weightUnit,
    warehouse:
      isStretchedFrame(frameKey) && !isPaperMaterial(material) ? "mayapuri" : "nariana",
  };

  if (templatePricing) {
    next.price = templatePricing.price;
    next.compareAtPrice = templatePricing.compareAt;
    next.cost = templatePricing.cost;
  }
  if (templateWeight != null) {
    next.weight = templateWeight;
  } else if (variant.weight != null) {
    next.weight = variant.weight;
  }

  return next;
}

function buildVariants(productId, shape) {
  const { sizes, shape: normalizedShape } = getTemplateForShape(shape);
  const variants = [];

  function pushRows(material, sizeCodes, rows) {
    for (const code of sizeCodes) {
      const sizeLabel = sizes[code];
      if (!sizeLabel) continue;
      for (const row of rows) {
        const pricing = pricingForVariant(
          normalizedShape,
          code,
          material,
          row.frame
        );
        if (!pricing) continue;
        const base = {
          sizeCode: code,
          size: sizeLabel,
          material,
          frame: row.frame,
          exportFrame: frameDisplayLabel(row.frame),
          sku: `${productId}-${code}-${row.n}`,
          price: pricing.price,
          compareAtPrice: pricing.compareAt,
          cost: pricing.cost,
        };
        variants.push(applyVariantDefaults(base, normalizedShape));
      }
    }
  }

  // Canvas first so default / first selectable is Canvas M, not paper XS
  pushRows(MATERIAL_CANVAS, CANVAS_SIZE_CODES, VARIANT_ROWS_CANVAS);
  pushRows(MATERIAL_PAPER, PAPER_SIZE_CODES, VARIANT_ROWS_PAPER);

  return variants;
}

function refreshProductVariants(product, options = {}) {
  if (!product?.productId || !product.shape) {
    return product;
  }
  applyProductDefaults(product);
  const rebuild = Boolean(options.rebuild);
  if (rebuild || !product.variants?.length) {
    product.variants = buildVariants(product.productId, product.shape);
    return product;
  }
  product.variants = product.variants.map((variant) =>
    applyVariantDefaults(
      {
        ...variant,
        material: normalizeMaterial(variant.material || PRODUCT_MATERIAL),
        frame: normalizeFrame(variant.frame || variant.exportFrame),
        exportFrame: frameDisplayLabel(variant.exportFrame || variant.frame),
      },
      product.shape
    )
  );
  return product;
}

function minVariantPrice(variants) {
  if (!variants?.length) {
    return null;
  }
  return Math.min(...variants.map((v) => Number(v.price) || 0));
}

function sizeCodeFromLabel(label) {
  const text = String(label || "").trim();
  const match = text.match(/^(XS|S|M|L|XL)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function suffixForFrame(material, frame) {
  const rows = variantRowsForMaterial(material);
  const hit = rows.find((r) => r.frame === normalizeFrame(frame));
  return hit ? hit.n : null;
}

module.exports = {
  SIZE_CODES,
  CANVAS_SIZE_CODES,
  PAPER_SIZE_CODES,
  SQUARE_SIZES,
  RECTANGLE_SIZES,
  SQUARE_PRICES,
  RECTANGLE_PRICES,
  SQUARE_WEIGHTS,
  RECTANGLE_WEIGHTS,
  VARIANT_ROWS,
  VARIANT_ROWS_CANVAS,
  VARIANT_ROWS_PAPER,
  MATERIAL_CANVAS,
  MATERIAL_PAPER,
  PRODUCT_MATERIAL,
  DEFAULT_METAFIELDS,
  PRODUCT_DEFAULTS,
  FRAME_DISPLAY_LABELS,
  REFERENCE_PATH,
  normalizeShape,
  normalizeFrame,
  normalizeMaterial,
  isPaperMaterial,
  frameDisplayLabel,
  isStretchedFrame,
  pricingForVariant: pricingForVariantCompat,
  weightForVariant,
  getTemplateForShape,
  sizeCodesForMaterial,
  variantRowsForMaterial,
  buildVariants,
  applyProductDefaults,
  applyVariantDefaults,
  refreshProductVariants,
  getVariantReference,
  loadVariantReference,
  minVariantPrice,
  sizeCodeFromLabel,
  suffixForFrame,
};
