// Read-only snapshot of collections, menus and active products for the catalog audit.
const fs = require('fs');
const path = require('path');
const { shopifyGraphql } = require('../../lib/shopify-client');
const { getShopifyCredentials } = require('../../lib/config-store');

const OUT = path.join(process.env.USERPROFILE, 'Downloads', '_Catalog', 'Catalog Audit', 'data');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const { storeDomain, accessToken } = getShopifyCredentials();
  const q = (s, v) => shopifyGraphql(storeDomain, accessToken, s, v);

  const collections = [];
  let after = null;
  do {
    const d = await q(`query($a:String){ collections(first:100, after:$a){ pageInfo{hasNextPage endCursor} nodes{
      id handle title updatedAt descriptionHtml productsCount{count}
      ruleSet{ appliedDisjunctively rules{ column relation condition } }
      image{ url }
      nested: metafield(namespace:"custom", key:"nested_collections"){ value }
      related: metafield(namespace:"custom", key:"related_collections"){ value }
      seo{ title description }
    } } }`, { a: after });
    collections.push(...d.collections.nodes);
    after = d.collections.pageInfo.hasNextPage ? d.collections.pageInfo.endCursor : null;
  } while (after);
  const gidToHandle = Object.fromEntries(collections.map((c) => [c.id, c.handle]));
  for (const c of collections) {
    c.nested = c.nested ? JSON.parse(c.nested.value).map((g) => gidToHandle[g] || g) : [];
    c.related = c.related ? JSON.parse(c.related.value).map((g) => gidToHandle[g] || g) : [];
    c.productsCount = c.productsCount.count;
    c.descriptionText = (c.descriptionHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    delete c.descriptionHtml;
  }

  const menus = [];
  const md = await q(`{ menus(first:50){ nodes{ handle title items{ title url resourceId items{ title url resourceId items{ title url resourceId } } } } } }`);
  for (const m of md.menus.nodes) menus.push(m);
  const menuPlace = {};
  const walk = (menu, items, trail) => {
    for (const it of items || []) {
      const t = [...trail, it.title];
      const h = it.resourceId && gidToHandle[it.resourceId] ? gidToHandle[it.resourceId] : (it.url || '').match(/\/collections\/([^/?#]+)/)?.[1];
      if (h) (menuPlace[h] = menuPlace[h] || []).push(menu + ': ' + t.join(' > '));
      walk(menu, it.items, t);
    }
  };
  for (const m of menus) walk(m.handle, m.items, []);
  for (const c of collections) c.menus = menuPlace[c.handle] || [];

  const products = [];
  after = null;
  do {
    const d = await q(`query($a:String){ products(first:100, after:$a, query:"status:active"){ pageInfo{hasNextPage endCursor} nodes{
      id handle title productType vendor tags createdAt description
      featuredMedia{ ... on MediaImage { image { url } } }
      collections(first:60){ nodes{ handle } }
    } } }`, { a: after });
    for (const p of d.products.nodes) {
      products.push({
        id: p.id.split('/').pop(), handle: p.handle, title: p.title, type: p.productType, vendor: p.vendor,
        tags: p.tags, createdAt: p.createdAt, desc: (p.description || '').replace(/\s+/g, ' ').slice(0, 600),
        image: p.featuredMedia?.image?.url || '', collections: p.collections.nodes.map((c) => c.handle),
      });
    }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
    process.stdout.write('\rproducts ' + products.length);
  } while (after);

  fs.writeFileSync(path.join(OUT, 'collections.json'), JSON.stringify(collections, null, 1));
  fs.writeFileSync(path.join(OUT, 'menus.json'), JSON.stringify(menus, null, 1));
  fs.writeFileSync(path.join(OUT, 'products.json'), JSON.stringify(products));
  console.log('\ncollections', collections.length, 'products', products.length, '->', OUT);
})().catch((e) => { console.error(e.message); process.exit(1); });
