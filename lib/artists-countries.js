const fs = require("fs");
const path = require("path");
const os = require("os");
const { shopifyGraphql } = require("./shopify-client");
const { getShopifyCredentials, getOpenAiApiKey, loadConfig } = require("./config-store");
const {
  loadArtistsStore,
  saveArtistsStore,
  upsertArtist,
  ensureArtistsImageDir,
  ARTISTS_IMAGE_DIR,
} = require("./artists-store");
const { slugify } = require("./artists-scanner");

const COUNTRY_TYPE = "country";
const FLAGS_DIR = path.join(ARTISTS_IMAGE_DIR, "flags");

/** Curated fallbacks for Famous Painters set (override AI/wiki noise). */
const KNOWN_NATIONALITIES = {
  "august-macke": { countryName: "Germany", iso2: "DE" },
  banksy: { countryName: "United Kingdom", iso2: "GB" },
  "claude-monet": { countryName: "France", iso2: "FR" },
  "gustav-klimt": { countryName: "Austria", iso2: "AT" },
  "henri-edmond-cross": { countryName: "France", iso2: "FR" },
  "johannes-vermeer": { countryName: "Netherlands", iso2: "NL" },
  "john-singer-sargent": { countryName: "United States", iso2: "US" },
  "kamisaka-sekka": { countryName: "Japan", iso2: "JP" },
  "katsushika-hokusai": { countryName: "Japan", iso2: "JP" },
  "ohara-koson": { countryName: "Japan", iso2: "JP" },
  "raja-ravi-verma": { countryName: "India", iso2: "IN" },
  "utagawa-kuniyoshi": { countryName: "Japan", iso2: "JP" },
  "vincent-van-gogh": { countryName: "Netherlands", iso2: "NL" },
  "winslow-homer": { countryName: "United States", iso2: "US" },
};

const NAME_TO_ISO = {
  france: "FR",
  germany: "DE",
  austria: "AT",
  netherlands: "NL",
  "united kingdom": "GB",
  uk: "GB",
  england: "GB",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  america: "US",
  japan: "JP",
  india: "IN",
  italy: "IT",
  spain: "ES",
  belgium: "BE",
  switzerland: "CH",
  russia: "RU",
  china: "CN",
};

function ensureFlagsDir() {
  ensureArtistsImageDir();
  if (!fs.existsSync(FLAGS_DIR)) {
    fs.mkdirSync(FLAGS_DIR, { recursive: true });
  }
  return FLAGS_DIR;
}

function countryHandleFromName(countryName, iso2) {
  const fromName = slugify(countryName);
  if (fromName) return fromName;
  return String(iso2 || "country").toLowerCase();
}

function normalizeCountryResult(input) {
  let countryName = String(input?.countryName || input?.name || "").trim();
  let iso2 = String(input?.iso2 || input?.countryIso2 || "")
    .trim()
    .toUpperCase();
  if (!iso2 && countryName) {
    iso2 = NAME_TO_ISO[countryName.toLowerCase()] || "";
  }
  if (!countryName && iso2) {
    const entry = Object.entries(NAME_TO_ISO).find(([, code]) => code === iso2);
    if (entry) {
      countryName = entry[0]
        .split(" ")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      if (iso2 === "US") countryName = "United States";
      if (iso2 === "GB") countryName = "United Kingdom";
    }
  }
  if (!countryName || !iso2 || iso2.length !== 2) return null;
  const handle = countryHandleFromName(countryName, iso2);
  return { countryName, iso2, countryHandle: handle };
}

async function resolveNationalityFromOpenAi(artist) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) return null;
  const config = loadConfig();
  const model = config.roomDetection?.openaiModel || "gpt-4o-mini";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Return the artist's primary nationality as a modern country name and ISO 3166-1 alpha-2 code.",
        },
        {
          role: "user",
          content: `Artist: ${artist.name}\nFolder: ${artist.folderName || ""}\nWikipedia: ${artist.wikipediaUrl || ""}\nReturn JSON: { "countryName": "France", "iso2": "FR" }`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) return null;
  const data = await response.json();
  try {
    return normalizeCountryResult(JSON.parse(data.choices?.[0]?.message?.content || "{}"));
  } catch {
    return null;
  }
}

async function resolveNationalityFromWikipedia(artist) {
  const title =
    (artist.wikipediaUrl || "").split("/wiki/")[1] ||
    String(artist.name || "").replace(/ /g, "_");
  if (!title) return null;
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(decodeURIComponent(title))}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "EditProArtists/1.0 (paintroad.com; local tool)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return null;
    const summary = await response.json();
    const extract = String(summary.extract || "").toLowerCase();
    // Simple keyword scan for common nationalities in this catalog
    const hints = [
      ["french", "France", "FR"],
      ["german", "Germany", "DE"],
      ["austrian", "Austria", "AT"],
      ["dutch", "Netherlands", "NL"],
      ["netherlands", "Netherlands", "NL"],
      ["british", "United Kingdom", "GB"],
      ["english", "United Kingdom", "GB"],
      ["american", "United States", "US"],
      ["japanese", "Japan", "JP"],
      ["indian", "India", "IN"],
    ];
    for (const [needle, countryName, iso2] of hints) {
      if (extract.includes(needle)) {
        return normalizeCountryResult({ countryName, iso2 });
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveArtistNationality(artist) {
  if (artist.nationality && artist.countryIso2 && artist.countryHandle) {
    return {
      countryName: artist.nationality,
      iso2: artist.countryIso2,
      countryHandle: artist.countryHandle,
    };
  }
  const known = KNOWN_NATIONALITIES[artist.id];
  if (known) return normalizeCountryResult(known);

  const fromWiki = await resolveNationalityFromWikipedia(artist);
  if (fromWiki) return fromWiki;

  const fromAi = await resolveNationalityFromOpenAi(artist);
  if (fromAi) return fromAi;

  throw new Error(`Could not resolve nationality for ${artist.name}`);
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function downloadFlag(iso2) {
  ensureFlagsDir();
  const code = String(iso2).toLowerCase();
  const dest = path.join(FLAGS_DIR, `${code}.png`);
  if (fs.existsSync(dest)) return dest;
  const url = `https://flagcdn.com/w160/${code}.png`;
  const response = await fetch(url, {
    headers: { "User-Agent": "EditProArtists/1.0" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`Flag download failed for ${iso2} (${response.status})`);
  }
  fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
  return dest;
}

async function stagedUploadFileResource(storeDomain, accessToken, localPath) {
  const filename = path.basename(localPath);
  const mimeType = mimeTypeForPath(localPath);
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          filename,
          mimeType,
          resource: "FILE",
          httpMethod: "POST",
        },
      ],
    }
  );
  const result = data.stagedUploadsCreate;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join("; "));
  }
  const target = result.stagedTargets?.[0];
  if (!target?.url || !target.resourceUrl) {
    throw new Error("Staged upload target missing.");
  }
  const fileBuffer = fs.readFileSync(localPath);
  const form = new FormData();
  for (const param of target.parameters || []) {
    form.append(param.name, param.value);
  }
  form.append("file", new Blob([fileBuffer], { type: mimeType }), filename);
  const uploadResponse = await fetch(target.url, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => "");
    throw new Error(`Staged upload failed (${uploadResponse.status}): ${text.slice(0, 200)}`);
  }
  return { resourceUrl: target.resourceUrl, filename };
}

async function fileCreate(storeDomain, accessToken, resourceUrl, filename, alt) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation FileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus ... on MediaImage { id } }
        userErrors { field message code }
      }
    }`,
    {
      files: [
        {
          originalSource: resourceUrl,
          filename,
          contentType: "IMAGE",
          alt: alt || filename,
        },
      ],
    }
  );
  const errors = data.fileCreate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.fileCreate?.files?.[0] || null;
}

async function waitForFileReady(storeDomain, accessToken, fileId, attempts = 12) {
  for (let i = 0; i < attempts; i += 1) {
    const data = await shopifyGraphql(
      storeDomain,
      accessToken,
      `query($id: ID!) {
        node(id: $id) {
          ... on File { fileStatus }
          ... on MediaImage { id fileStatus }
        }
      }`,
      { id: fileId }
    );
    const status = data.node?.fileStatus;
    if (status === "READY") return;
    if (status === "FAILED") {
      throw new Error(`Shopify file processing failed for ${fileId}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function getCachedCountry(store, handle) {
  return (store.countries || []).find((c) => c.handle === handle) || null;
}

function upsertCachedCountry(store, country) {
  const countries = [...(store.countries || [])];
  const idx = countries.findIndex((c) => c.handle === country.handle);
  if (idx >= 0) countries[idx] = { ...countries[idx], ...country };
  else countries.push(country);
  store.countries = countries;
  return store;
}

async function upsertCountryMetaobject(storeDomain, accessToken, country, flagFileId) {
  const fields = [{ key: "name", value: country.name }];
  if (flagFileId) {
    fields.push({ key: "flag", value: flagFileId });
  }
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation Upsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
        metaobject { id handle }
        userErrors { field message code }
      }
    }`,
    {
      handle: { type: COUNTRY_TYPE, handle: country.handle },
      metaobject: { fields },
    }
  );
  const errors = data.metaobjectUpsert?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.metaobjectUpsert.metaobject;
}

async function ensureCountryOnShopify(store, nationality, { apply }) {
  const handle = nationality.countryHandle;
  const cached = getCachedCountry(store, handle);

  if (!apply) {
    const draft = {
      handle,
      name: nationality.countryName,
      iso2: nationality.iso2,
      shopifyMetaobjectId: cached?.shopifyMetaobjectId || null,
      shopifyFlagFileId: cached?.shopifyFlagFileId || null,
      flagLocalPath: cached?.flagLocalPath || null,
    };
    upsertCachedCountry(store, draft);
    return draft;
  }

  if (cached?.shopifyMetaobjectId && cached.shopifyFlagFileId) {
    return cached;
  }

  const { storeDomain, accessToken } = getShopifyCredentials();
  let flagFileId = cached?.shopifyFlagFileId || null;
  let flagLocalPath = cached?.flagLocalPath || null;

  if (!flagFileId) {
    flagLocalPath = await downloadFlag(nationality.iso2);
    const staged = await stagedUploadFileResource(
      storeDomain,
      accessToken,
      flagLocalPath
    );
    const created = await fileCreate(
      storeDomain,
      accessToken,
      staged.resourceUrl,
      `flag-${nationality.iso2.toLowerCase()}.png`,
      `${nationality.countryName} flag`
    );
    flagFileId = created?.id || null;
    if (flagFileId) {
      await waitForFileReady(storeDomain, accessToken, flagFileId);
    }
  }

  const metaobject = await upsertCountryMetaobject(
    storeDomain,
    accessToken,
    { handle, name: nationality.countryName },
    flagFileId
  );

  const entry = {
    handle,
    name: nationality.countryName,
    iso2: nationality.iso2,
    shopifyMetaobjectId: metaobject.id,
    shopifyFlagFileId: flagFileId,
    flagLocalPath,
  };
  upsertCachedCountry(store, entry);
  return entry;
}

async function setArtistCountryField(storeDomain, accessToken, artistMetaobjectId, countryMetaobjectId) {
  const data = await shopifyGraphql(
    storeDomain,
    accessToken,
    `mutation Update($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message code }
      }
    }`,
    {
      id: artistMetaobjectId,
      metaobject: {
        fields: [{ key: "country", value: countryMetaobjectId }],
      },
    }
  );
  const errors = data.metaobjectUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

/**
 * Resolve nationality for all artists, upsert countries, link Shopify artists.
 */
async function applyArtistNationalities({ apply = false } = {}) {
  const store = loadArtistsStore();
  if (!Array.isArray(store.countries)) store.countries = [];

  const mappings = [];
  const countryHandles = new Set();
  const errors = [];

  for (const artist of store.artists || []) {
    try {
      const nationality = await resolveArtistNationality(artist);
      countryHandles.add(nationality.countryHandle);
      const updated = {
        ...artist,
        nationality: nationality.countryName,
        countryIso2: nationality.iso2,
        countryHandle: nationality.countryHandle,
      };
      upsertArtist(store, updated);
      mappings.push({
        artistId: artist.id,
        artistName: artist.name,
        ...nationality,
        onShopify: Boolean(artist.shopifyMetaobjectId),
      });
    } catch (error) {
      errors.push({
        artistId: artist.id,
        artistName: artist.name,
        error: error.message || String(error),
      });
    }
  }

  const countriesCreated = [];
  for (const handle of countryHandles) {
    const sample = mappings.find((m) => m.countryHandle === handle);
    if (!sample) continue;
    try {
      const entry = await ensureCountryOnShopify(
        store,
        {
          countryName: sample.countryName,
          iso2: sample.iso2,
          countryHandle: handle,
        },
        { apply }
      );
      countriesCreated.push(entry);
    } catch (error) {
      errors.push({
        countryHandle: handle,
        error: error.message || String(error),
      });
    }
  }

  const linked = [];
  if (apply) {
    const { storeDomain, accessToken } = getShopifyCredentials();
    for (const artist of store.artists || []) {
      if (!artist.shopifyMetaobjectId || !artist.countryHandle) continue;
      const country = getCachedCountry(store, artist.countryHandle);
      if (!country?.shopifyMetaobjectId) continue;
      try {
        await setArtistCountryField(
          storeDomain,
          accessToken,
          artist.shopifyMetaobjectId,
          country.shopifyMetaobjectId
        );
        upsertArtist(store, {
          ...artist,
          shopifyCountryId: country.shopifyMetaobjectId,
        });
        linked.push({
          artistId: artist.id,
          countryHandle: artist.countryHandle,
          countryId: country.shopifyMetaobjectId,
        });
      } catch (error) {
        errors.push({
          artistId: artist.id,
          error: error.message || String(error),
        });
      }
    }
  } else {
    // Dry-run: still attach local shopifyCountryId from cache if present
    for (const artist of store.artists || []) {
      if (!artist.countryHandle) continue;
      const country = getCachedCountry(store, artist.countryHandle);
      if (country?.shopifyMetaobjectId) {
        upsertArtist(store, {
          ...artist,
          shopifyCountryId: country.shopifyMetaobjectId,
        });
      }
    }
  }

  saveArtistsStore(store);

  const report = {
    generatedAt: new Date().toISOString(),
    apply,
    mappingCount: mappings.length,
    uniqueCountries: [...countryHandles],
    countries: countriesCreated,
    linkedCount: linked.length,
    linked,
    mappings,
    errors,
  };

  const reportPath = path.join(
    os.homedir(),
    ".editpro",
    "artist-nationalities-report.json"
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  report.reportPath = reportPath;
  report.store = store;
  return report;
}

module.exports = {
  COUNTRY_TYPE,
  KNOWN_NATIONALITIES,
  resolveArtistNationality,
  ensureCountryOnShopify,
  applyArtistNationalities,
  getCachedCountry,
  normalizeCountryResult,
};
