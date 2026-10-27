const API_VERSION = "2026-01";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableShopifyError(error, status) {
  const message = String(error?.message || error || "");
  return status === 429 || status >= 500 || /throttl|exceeded|unavailable|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

async function shopifyGraphql(storeDomain, accessToken, query, variables = {}, apiVersion = API_VERSION) {
  if (!storeDomain || !accessToken) {
    throw new Error("Shopify store domain and access token are required.");
  }

  const url = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      lastError = new Error(`Shopify returned invalid JSON (${response.status}).`);
      if (!isRetryableShopifyError(lastError, response.status) || attempt === 5) throw lastError;
      await sleep(1000 * (attempt + 1));
      continue;
    }

    if (!response.ok) {
      lastError = new Error(payload.errors?.[0]?.message || `Shopify request failed (${response.status}).`);
      if (!isRetryableShopifyError(lastError, response.status) || attempt === 5) throw lastError;
      await sleep(1000 * (attempt + 1));
      continue;
    }

    if (payload.errors?.length) {
      lastError = new Error(payload.errors.map((error) => error.message).join("; "));
      const throttled = payload.errors.some(
        (error) => error.extensions?.code === "THROTTLED" || /throttl/i.test(error.message || "")
      );
      if (!throttled || attempt === 5) throw lastError;
      await sleep(1000 * (attempt + 1));
      continue;
    }

    return payload.data;
  }
  throw lastError || new Error("Shopify request failed.");
}

async function testConnection(storeDomain, accessToken) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `query { shop { name myshopifyDomain } }`
  );
  return data.shop;
}

module.exports = {
  API_VERSION,
  shopifyGraphql,
  testConnection,
};
