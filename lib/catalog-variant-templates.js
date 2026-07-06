const SIZE_CODES = ["XS", "S", "M", "L", "XL"];

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
  { material: "Fine Art Paper", frame: "black", exportFrame: "black-frame", n: 1 },
  { material: "Fine Art Paper", frame: "white", exportFrame: "white", n: 2 },
  { material: "Fine Art Paper", frame: "wooden", exportFrame: "wooden", n: 3 },
  { material: "Canvas", frame: "stretched-canvas", exportFrame: "stretched-canvas", n: 4 },
  { material: "Canvas", frame: "black", exportFrame: "black-frame", n: 5 },
  { material: "Canvas", frame: "white", exportFrame: "white", n: 6 },
  { material: "Canvas", frame: "wooden", exportFrame: "wooden", n: 7 },
];

const DEFAULT_METAFIELDS = {
  artworkFrameMaterial: ["wood", "plastic"],
  frameStyle: ["black", "white", "wooden", "stretched-canvas"],
};

const PRODUCT_DEFAULTS = {
  vendor: "Royal Creations",
  productType: "Painting",
  productCategory:
    "Home & Garden > Decor > Artwork > Posters, Prints, & Visual Artwork > Visual Artwork",
  inventoryQty: 100,
  inventoryPolicy: "continue",
  fulfillmentService: "manual",
  requiresShipping: true,
  taxable: true,
  weightUnit: "g",
  status: "active",
  published: true,
};

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
  const { sizes, prices } = getTemplateForShape(shape);
  const variants = [];

  for (const code of SIZE_CODES) {
    const sizeLabel = sizes[code];
    const priceRow = prices[code];
    if (!sizeLabel || !priceRow) {
      continue;
    }

    for (const row of VARIANT_ROWS) {
      const materialKey = row.material === "Fine Art Paper" ? "paper" : "canvas";
      const pricing = priceRow[materialKey];
      variants.push({
        sizeCode: code,
        size: sizeLabel,
        material: row.material,
        frame: row.frame,
        exportFrame: row.exportFrame,
        sku: `${productId}-${code}-${row.n}`,
        price: pricing.price,
        compareAtPrice: pricing.compareAt,
        cost: pricing.cost,
        inventoryQty: PRODUCT_DEFAULTS.inventoryQty,
        inventoryPolicy: PRODUCT_DEFAULTS.inventoryPolicy,
        fulfillmentService: PRODUCT_DEFAULTS.fulfillmentService,
        requiresShipping: PRODUCT_DEFAULTS.requiresShipping,
        taxable: PRODUCT_DEFAULTS.taxable,
        weightUnit: PRODUCT_DEFAULTS.weightUnit,
      });
    }
  }

  return variants;
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
  DEFAULT_METAFIELDS,
  PRODUCT_DEFAULTS,
  normalizeShape,
  getTemplateForShape,
  buildVariants,
  minVariantPrice,
};
