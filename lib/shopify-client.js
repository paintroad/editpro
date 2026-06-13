const API_VERSION = "2025-01";

async function shopifyGraphql(storeDomain, accessToken, query, variables = {}) {
  if (!storeDomain || !accessToken) {
    throw new Error("Shopify store domain and access token are required.");
  }

  const url = `https://${storeDomain}/admin/api/${API_VERSION}/graphql.json`;
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
    throw new Error(`Shopify returned invalid JSON (${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(payload.errors?.[0]?.message || `Shopify request failed (${response.status}).`);
  }

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join("; "));
  }

  return payload.data;
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
