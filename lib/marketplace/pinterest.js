const { joinList } = require("./product-normalizer");

function productLink(product, ctx) {
  const domain = String(ctx.storeDomain || "").replace(/^https?:\/\//, "");
  const handle = product.handle || product.productId;
  if (!domain || !handle) {
    return "";
  }
  return `https://${domain}/products/${handle}`;
}

function pinterestAdapter() {
  return {
    id: "pinterest",
    name: "Pinterest",
    format: "csv",
    defaultSampleName: "pinterest_product_sample_csv_feed.csv",
    defaultCurrency: "USD",
    notes: "Exports a Pinterest product CSV feed.",
    inspect(sampleRows) {
      const headers = (sampleRows[0] || []).map((h) => String(h || "").trim());
      return {
        sheetName: null,
        headers,
        dataStartRow: 2,
        columnCount: headers.length,
      };
    },
    mapRow({ product, variant }, ctx) {
      const price = variant.price != null ? Number(variant.price).toFixed(2) : "";
      const currency = ctx.currencyCode || "USD";
      const salePrice =
        variant.compareAtPrice != null && variant.compareAtPrice > (variant.price || 0)
          ? Number(variant.compareAtPrice).toFixed(2)
          : "";
      const link = productLink(product, ctx);
      const imageUrls = product.imageUrls || [];

      return {
        id: variant.sku || `${product.handle}-${variant.size || "default"}`,
        item_group_id: product.handle || product.productId,
        title: product.title,
        description: product.descriptionPlain || product.seoDescription || "",
        link,
        image_link: imageUrls[0] || "",
        price: price ? `${price} ${currency}` : "",
        availability: "in stock",
        condition: "new",
        google_product_category: "Home & Garden > Decor > Artwork",
        product_type: product.productType || joinList(product.tags, " > ") || "Painting",
        additional_image_link: imageUrls[1] || "",
        sale_price: salePrice ? `${salePrice} ${currency}` : "",
        brand: product.vendor || ctx.shopName || "",
        gender: "",
        age_group: "",
        size: variant.size || "",
        size_type: "regular",
        shipping: "",
        custom_label_0: product.productType || "",
        adwords_redirect: link,
      };
    },
    buildRows(sampleRows, variantRows, ctx) {
      const meta = this.inspect(sampleRows);
      const headers = meta.headers;
      const output = [headers];
      for (const entry of variantRows) {
        const mapped = this.mapRow(entry, ctx);
        output.push(headers.map((header) => mapped[header] ?? ""));
      }
      // #region agent log
      const idIdx = headers.indexOf("id");
      const imgIdx = headers.indexOf("image_link");
      const descIdx = headers.indexOf("description");
      const linkIdx = headers.indexOf("link");
      let emptyImg = 0, emptyDesc = 0;
      const idSeen = new Map();
      let dupIds = 0;
      const linkDomains = new Set();
      for (let i = 1; i < output.length; i += 1) {
        const r = output[i];
        if (!r[imgIdx]) emptyImg += 1;
        if (!r[descIdx]) emptyDesc += 1;
        const idVal = r[idIdx];
        const c = (idSeen.get(idVal) || 0) + 1;
        idSeen.set(idVal, c);
        if (c === 2) dupIds += 1;
        const lv = String(r[linkIdx] || "");
        const m = lv.match(/^https?:\/\/([^/]+)/);
        if (m && linkDomains.size < 5) linkDomains.add(m[1]);
      }
      fetch('http://127.0.0.1:7549/ingest/5d3de01a-a775-4a96-bbdd-c6abcd6ee00a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'511b6d'},body:JSON.stringify({sessionId:'511b6d',hypothesisId:'A/B/C/D/dup/link',location:'pinterest.js:72',message:'pinterest buildRows stats',data:{dataRows:output.length-1,uniqueIds:idSeen.size,duplicateIdValues:dupIds,emptyImage:emptyImg,emptyDescription:emptyDesc,ctxStoreDomain:ctx.storeDomain||null,linkDomainsSample:[...linkDomains],firstMappedRow:JSON.stringify(this.mapRow(variantRows[0],ctx))},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      return output;
    },
  };
}

module.exports = {
  pinterestAdapter,
};
