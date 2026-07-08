function truncate(text, max = 160) {
  const value = String(text || "").trim();
  if (value.length <= max) {
    return value;
  }
  const sliced = value.slice(0, max);
  const lastBreak = Math.max(sliced.lastIndexOf(" "), sliced.lastIndexOf("\t"), sliced.lastIndexOf("\n"));
  if (lastBreak > 0) {
    return sliced.slice(0, lastBreak).trimEnd();
  }
  return sliced.trimEnd();
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

function wrapDescriptionHtml(plain) {
  const text = String(plain || "").trim();
  if (!text) {
    return "";
  }
  return `<p><span data-sheets-root="1">${text.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span></p>`;
}

function buildSeoTitle(title) {
  return `Buy ${title} painting online at lowest prices at Paint Road`;
}

function buildSeoDescription(title, minPrice) {
  const price = minPrice != null ? ` only ₹${minPrice}.00` : "";
  return `Buy ${title} painting online at lowest prices${price} at Paint Road!`;
}

module.exports = {
  truncate,
  slugify,
  wrapDescriptionHtml,
  buildSeoTitle,
  buildSeoDescription,
};
