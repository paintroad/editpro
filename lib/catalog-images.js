/** Enumerate all catalog images with stable file IDs. */

function pushProductImages(images, product) {
  (product.media?.nodes || []).forEach((node, index) => {
    const fileId = node?.id;
    const url = node?.image?.url || node?.url || "";
    if (!fileId || !url) {
      return;
    }
    images.push({
      fileId,
      resourceType: "product",
      resourceId: product.id,
      resourceTitle: product.title || "",
      imageIndex: index + 1,
      url,
      alt: node.alt || "",
    });
  });
}

function pushSingleImage(images, resourceType, resource) {
  const img = resource.image;
  const fileId = img?.id;
  const url = img?.url || img?.image?.url || "";
  if (!fileId || !url) {
    return;
  }
  images.push({
    fileId,
    resourceType,
    resourceId: resource.id,
    resourceTitle: resource.title || "",
    imageIndex: 1,
    url,
    alt: img.alt || img.altText || "",
  });
}

function enumerateCatalogImages(storeData) {
  const images = [];
  for (const product of storeData?.products || []) {
    pushProductImages(images, product);
  }
  for (const collection of storeData?.collections || []) {
    pushSingleImage(images, "collection", collection);
  }
  for (const article of storeData?.articles || []) {
    pushSingleImage(images, "article", article);
  }
  return images;
}

module.exports = { enumerateCatalogImages };
