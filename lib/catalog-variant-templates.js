const fs = require("fs");
const path = require("path");
const os = require("os");

const SIZE_CODES = ["XS", "S", "M", "L", "XL"];

const REFERENCE_PATH = path.join(os.homedir(), ".editpro", "catalog-variant-reference.json");

const SQUARE_SIZES = {
  XS: 'XS - 10"x10"',
  S: 'S - 12"x12"',
  M: 'M - 18"x18"',
  L: 'L - 24"x24"',
  XL: 'XL - 36"x36"',
};

const RECTANGLE_SIZES = {
  XS: 'XS - 8"x10"',
  S: 'S - 11"x14"',
  M: 'M - 16"x20"',
  L: 'L - 18"x24"',
  XL: 'XL - 24"x36"',
};

const SQUARE_PRICES = {
  XS: {
    paper: { price: 699, compareAt: 1299, cost: 199 },
    canvas: { price: 999, compareAt: 1499, cost: 249 },
  },
  S: {
    paper: { price: 999, compareAt: 1499, cost: 249 },
    canvas: { price: 1499, compareAt: 2499, cost: 399 },
  },
  M: {
    paper: { price: 1499, compareAt: 2499, cost: 399 },
    canvas: { price: 2999, compareAt: 3999, cost: 599 },
  },
  L: {
    paper: { price: 2999, compareAt: 3999, cost: 599 },
    canvas: { price: 4999, compareAt: 5999, cost: 699 },
  },
  XL: {
    paper: { price: 5499, compareAt: 6999, cost: 1099 },
    canvas: { price: 6999, compareAt: 7999, cost: 1399 },
  },
};

const RECTANGLE_PRICES = {
  XS: {
    paper: { price: 499, compareAt: 999, cost: 199 },
    canvas: { price: 999, compareAt: 1499, cost: 249 },
  },
  S: {
    paper: { price: 999, compareAt: 1499, cost: 249 },
    canvas: { price: 1499, compareAt: 1999, cost: 399 },
  },
  M: {
    paper: { price: 1499, compareAt: 1999, cost: 399 },
    canvas: { price: 2499, compareAt: 2999, cost: 599 },
  },
  L: {
    paper: { price: 2499, compareAt: 2999, cost: 599 },
    canvas: { price: 2999, compareAt: 3499, cost: 699 },
  },
  XL: {
    paper: { price: 3999, compareAt: 4999, cost: 1099 },
    canvas: { price: 4999, compareAt: 5999, cost: 1399 },
  },
};

const VARIANT_ROWS = [
  { material: "Fine Art Paper", frame: "black", n: 1 },
  { material: "Fine Art Paper", frame: "white", n: 2 },
  { material: "Fine Art Paper", frame: "wooden", n: 3 },
  { material: "Fine Art Paper", frame: "dark-wood", n: 8 },
  { material: "Canvas", frame: "stretched-canvas", n: 4 },
  { material: "Canvas", frame: "black", n: 5 },
  { material: "Canvas", frame: "white", n: 6 },
  { material: "Canvas", frame: "wooden", n: 7 },
  { material: "Canvas", frame: "dark-wood", n: 9 },
];

/** Stretched Canvas: +₹500 sell/compareAt/cost for M, L, XL (both shapes). */
const STRETCHED_SURCHARGE = 500;
const STRETCHED_SURCHARGE_SIZES = new Set(["M", "L", "XL"]);

const DEFAULT_METAFIELDS = {
  artworkFrameMaterial: ["wood", "plastic"],
  frameStyle: [
    "Black",
    "White",
    "Wooden Finish",
    "Dark Wood Finish",
    "Stretched Canvas",
  ],
};

const FRAME_DISPLAY_LABELS = {
  black: "Black",
  white: "White",
  wooden: "Wooden Finish",
  "dark-wood": "Dark Wood Finish",
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
  if (f === "dark-wood-finish" || f === "darkwood" || f === "dark-wood") {
    return "dark-wood";
  }
  if (f === "stretchedcanvas") {
    return "stretched-canvas";
  }
  return f;
}

function appliesStretchedSurcharge(sizeCode, frame) {
  return (
    normalizeFrame(frame) === "stretched-canvas" &&
    STRETCHED_SURCHARGE_SIZES.has(String(sizeCode || "").toUpperCase())
  );
}

function applyStretchedSurcharge(sizeCode, frame, pricing) {
  if (!pricing || !appliesStretchedSurcharge(sizeCode, frame)) {
    return pricing;
  }
  return {
    price: Number(pricing.price) + STRETCHED_SURCHARGE,
    compareAt: Number(pricing.compareAt) + STRETCHED_SURCHARGE,
    cost: Number(pricing.cost) + STRETCHED_SURCHARGE,
  };
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

function variantReferenceKey(shape, sizeCode, material, frame) {
  return `${normalizeShape(shape)}|${sizeCode}|${material}|${normalizeFrame(frame)}`;
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
          parts[3] = normalizeFrame(parts[3]);
          out[parts.join("|")] = row;
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

function getVariantReference(shape, sizeCode, material, frame) {
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

function pricingForVariant(shape, sizeCode, material, frame) {
  const { prices } = getTemplateForShape(shape);
  const priceRow = prices[sizeCode];
  if (!priceRow) {
    return null;
  }
  const materialKey =
    String(material || "").toLowerCase().includes("paper") ? "paper" : "canvas";
  const base = priceRow[materialKey];
  if (!base) {
    return null;
  }
  return applyStretchedSurcharge(sizeCode, frame, base);
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
  if (!product.metafields || typeof product.metafields !== "object") {
    product.metafields = {};
  }
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
    // Upgrade legacy "Wooden" → "Wooden Finish" via frameDisplayLabel already;
    // ensure defaults win for known keys.
    product.metafields.frameStyle = merged.filter(
      (label, idx, arr) => arr.indexOf(label) === idx
    );
  }
  return product;
}

function applyVariantDefaults(variant, shape) {
  const frameKey = normalizeFrame(variant.frame || variant.exportFrame);
  const ref = getVariantReference(shape, variant.sizeCode, variant.material, frameKey);
  const templatePricing = pricingForVariant(
    shape,
    variant.sizeCode,
    variant.material,
    frameKey
  );
  let cost =
    templatePricing?.cost != null
      ? templatePricing.cost
      : ref?.cost != null
        ? ref.cost
        : variant.cost;
  if (
    appliesStretchedSurcharge(variant.sizeCode, frameKey) &&
    templatePricing == null &&
    cost != null
  ) {
    cost = Number(cost) + STRETCHED_SURCHARGE;
  }
  const weight = ref?.weight != null ? ref.weight : variant.weight;
  const weightUnit =
    ref?.weightUnit != null ? normalizeWeightUnit(ref.weightUnit) : variant.weightUnit;

  const next = {
    ...variant,
    frame: frameKey,
    exportFrame: frameDisplayLabel(frameKey),
    cost: cost != null ? cost : variant.cost,
    weight: weight != null ? weight : variant.weight ?? null,
    weightUnit: weightUnit || PRODUCT_DEFAULTS.weightUnit,
    inventoryQty: PRODUCT_DEFAULTS.inventoryQty,
    inventoryPolicy: PRODUCT_DEFAULTS.inventoryPolicy,
    fulfillmentService: PRODUCT_DEFAULTS.fulfillmentService,
    requiresShipping: PRODUCT_DEFAULTS.requiresShipping,
    taxable: PRODUCT_DEFAULTS.taxable,
    tracked: PRODUCT_DEFAULTS.tracked,
    countryOfOrigin: PRODUCT_DEFAULTS.countryOfOrigin,
  };
  if (templatePricing) {
    next.price = templatePricing.price;
    next.compareAtPrice = templatePricing.compareAt;
  }
  return next;
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
    return { sizes: RECTANGLE_SIZES, prices: RECTANGLE_PRICES, shape: "rectangle" };
  }
  return { sizes: SQUARE_SIZES, prices: SQUARE_PRICES, shape: "square" };
}

function buildVariants(productId, shape) {
  const { sizes, prices, shape: normalizedShape } = getTemplateForShape(shape);
  const variants = [];

  for (const code of SIZE_CODES) {
    const sizeLabel = sizes[code];
    const priceRow = prices[code];
    if (!sizeLabel || !priceRow) {
      continue;
    }

    for (const row of VARIANT_ROWS) {
      const materialKey = row.material === "Fine Art Paper" ? "paper" : "canvas";
      const pricing = applyStretchedSurcharge(
        code,
        row.frame,
        priceRow[materialKey]
      );
      const base = {
        sizeCode: code,
        size: sizeLabel,
        material: row.material,
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

  return variants;
}

function refreshProductVariants(product, options = {}) {
  if (!product?.productId || !product.shape) {
    return product;
  }
  const rebuild = Boolean(options.rebuild);
  if (rebuild || !product.variants?.length) {
    product.variants = buildVariants(product.productId, product.shape);
    return product;
  }
  product.variants = product.variants.map((variant) =>
    applyVariantDefaults(
      {
        ...variant,
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

module.exports = {
  SIZE_CODES,
  SQUARE_SIZES,
  RECTANGLE_SIZES,
  SQUARE_PRICES,
  RECTANGLE_PRICES,
  VARIANT_ROWS,
  STRETCHED_SURCHARGE,
  STRETCHED_SURCHARGE_SIZES,
  DEFAULT_METAFIELDS,
  PRODUCT_DEFAULTS,
  FRAME_DISPLAY_LABELS,
  REFERENCE_PATH,
  normalizeShape,
  normalizeFrame,
  frameDisplayLabel,
  appliesStretchedSurcharge,
  applyStretchedSurcharge,
  pricingForVariant,
  getTemplateForShape,
  buildVariants,
  applyProductDefaults,
  applyVariantDefaults,
  refreshProductVariants,
  getVariantReference,
  loadVariantReference,
  minVariantPrice,
};
