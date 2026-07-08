const SIZE_CODE_DIGITS = {
  XS: "1",
  S: "2",
  M: "3",
  L: "4",
  XL: "5",
};

function upcCheckDigit(digits11) {
  const base = String(digits11 || "").replace(/\D/g, "");
  if (base.length !== 11) {
    return null;
  }
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const digit = Number(base[i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return String((10 - (sum % 10)) % 10);
}

function hashSkuToNineDigits(sku) {
  let hash = 0;
  const text = String(sku || "");
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return String(hash % 1_000_000_000).padStart(9, "0");
}

function buildUpcFromBase11(base11) {
  const digits = String(base11 || "").replace(/\D/g, "");
  if (digits.length !== 11) {
    return "";
  }
  const check = upcCheckDigit(digits);
  if (check == null) {
    return "";
  }
  return `${digits}${check}`;
}

function deriveUpcFromSku(sku) {
  const text = String(sku || "").trim();
  if (!text) {
    return "";
  }

  const match = text.match(/^(\d+)-([A-Za-z]+)-(\d+)$/);
  if (match) {
    const productId = String(match[1]).padStart(5, "0").slice(-5);
    const sizeDigit = SIZE_CODE_DIGITS[String(match[2]).toUpperCase()] || "0";
    const variantNum = String(match[3]).slice(-1);
    const base11 = `89${productId}${sizeDigit}${variantNum}00`.slice(0, 11);
    return buildUpcFromBase11(base11);
  }

  const base11 = `89${hashSkuToNineDigits(text)}`.slice(0, 11);
  return buildUpcFromBase11(base11);
}

function normalizeBarcodeDigits(barcode) {
  return String(barcode || "").replace(/\D/g, "");
}

function resolveAmazonProductId({ barcode }) {
  const digits = normalizeBarcodeDigits(barcode);

  if (digits.length === 12) {
    return { type: "UPC", value: digits };
  }

  if (digits.length === 13) {
    return { type: "EAN", value: digits };
  }

  if (digits.length === 14) {
    return { type: "GTIN", value: digits };
  }

  if (digits.length >= 8) {
    if (digits.length > 13) {
      return { type: "EAN", value: digits.slice(0, 13) };
    }
    return { type: "UPC", value: digits.padStart(12, "0").slice(-12) };
  }

  return { type: "GTIN Exempt", value: "" };
}

function resolveMarketplaceGtin({ barcode, sku }) {
  const digits = normalizeBarcodeDigits(barcode);

  if (digits.length === 12) {
    return {
      type: "UPC",
      value12: digits,
      value13: `0${digits}`,
    };
  }

  if (digits.length === 13) {
    return {
      type: "EAN",
      value12: digits.slice(1),
      value13: digits,
    };
  }

  if (digits.length >= 8) {
    if (digits.length === 14) {
      return {
        type: "GTIN",
        value12: digits.slice(2, 14),
        value13: digits.slice(1, 14),
      };
    }
    if (digits.length > 13) {
      const trimmed = digits.slice(0, 13);
      return {
        type: "EAN",
        value12: trimmed.slice(1),
        value13: trimmed,
      };
    }
    const padded = digits.padStart(12, "0").slice(-12);
    return {
      type: "UPC",
      value12: padded,
      value13: `0${padded}`,
    };
  }

  const value12 = deriveUpcFromSku(sku);
  if (!value12) {
    return {
      type: "GTIN Exempt",
      value12: "",
      value13: "",
    };
  }

  return {
    type: "UPC",
    value12,
    value13: `0${value12}`,
  };
}

module.exports = {
  upcCheckDigit,
  deriveUpcFromSku,
  resolveAmazonProductId,
  resolveMarketplaceGtin,
};
