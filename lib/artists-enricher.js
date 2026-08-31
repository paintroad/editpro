const fs = require("fs");
const path = require("path");
const {
  loadArtistsStore,
  saveArtistsStore,
  getArtist,
  upsertArtist,
  stripImagesFromHtml,
  ensureArtistsImageDir,
  portraitPathForSlug,
} = require("./artists-store");
const { getOpenAiApiKey, loadConfig } = require("./config-store");
const { resolveArtistNationality } = require("./artists-countries");

function wikipediaTitleCandidates(artist) {
  const name = artist.name || artist.folderName || "";
  const folder = artist.folderName || name;
  const candidates = [
    name,
    folder,
    folder.replace(/\?+$/g, "").trim(),
    name.replace(/\s+Style$/i, "").trim(),
    // Common spelling variant
    name === "Raja Ravi Verma" ? "Raja Ravi Varma" : null,
    name === "Henri Edmond Cross" ? "Henri-Edmond Cross" : null,
  ].filter(Boolean);
  return [...new Set(candidates)];
}

async function fetchWikipediaSummary(title) {
  const encoded = encodeURIComponent(title.replace(/ /g, "_"));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "EditProArtists/1.0 (paintroad.com; local tool)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Wikipedia error ${response.status} for "${title}"`);
  }
  const data = await response.json();
  if (data.type === "disambiguation") return null;
  return data;
}

async function resolveWikipedia(artist) {
  for (const title of wikipediaTitleCandidates(artist)) {
    try {
      const summary = await fetchWikipediaSummary(title);
      if (summary?.extract || summary?.content_urls?.desktop?.page) {
        return summary;
      }
    } catch {
      // try next title
    }
  }
  return null;
}

async function downloadPortraitIfMissing(artist, summary) {
  ensureArtistsImageDir();
  const dest = portraitPathForSlug(artist.id);
  if (fs.existsSync(dest)) {
    return dest;
  }
  const imageUrl =
    summary?.originalimage?.source || summary?.thumbnail?.source || null;
  if (!imageUrl) {
    return null;
  }
  const response = await fetch(imageUrl, {
    headers: {
      "User-Agent": "EditProArtists/1.0 (paintroad.com; local tool)",
    },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    throw new Error(`Failed to download portrait (${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  return dest;
}

async function generateBiographyHtml(artist, wikipediaExtract) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    // Fallback: wrap Wikipedia extract as simple paragraphs
    const text = String(wikipediaExtract || "").trim();
    if (!text) {
      throw new Error("OpenAI API key missing and no Wikipedia extract.");
    }
    const paras = text
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${escapeHtml(p)}</p>`);
    return stripImagesFromHtml(paras.join("\n"));
  }

  const config = loadConfig();
  const model = config.roomDetection?.openaiModel || "gpt-4o-mini";
  const prompt = `You write artist biographies for an online art print store (Paintroad).

Artist name: ${artist.name}

Wikipedia extract (source material):
${wikipediaExtract || "(none)"}

Write a biography focused ONLY on:
- the artist's life and historical context
- their style and notable body of work / famous pieces

Do NOT include:
- images, image URLs, markdown images, or HTML <img>
- shopping language, product pitches, or collection CTAs
- unrelated trivia

Return JSON: { "biographyHtml": "<p>...</p><p>...</p>" }
Use only these HTML tags: p, strong, em, ul, ol, li. 2–4 short paragraphs.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You write concise artist biographies as HTML. Never include images.",
        },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI error ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { biographyHtml: content };
  }
  const html = stripImagesFromHtml(parsed.biographyHtml || parsed.biography || "");
  if (!html) {
    throw new Error("OpenAI returned empty biography.");
  }
  return html;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function enrichArtistById(artistId) {
  const store = loadArtistsStore();
  const artist = getArtist(store, artistId);
  if (!artist) {
    throw new Error(`Artist not found: ${artistId}`);
  }

  try {
    const summary = await resolveWikipedia(artist);
    const wikipediaUrl =
      summary?.content_urls?.desktop?.page ||
      (summary?.title
        ? `https://en.wikipedia.org/wiki/${encodeURIComponent(summary.title.replace(/ /g, "_"))}`
        : artist.wikipediaUrl || "");
    const extract = summary?.extract || "";

    let imageLocalPath = null;
    try {
      imageLocalPath = await downloadPortraitIfMissing(artist, summary);
    } catch (imgErr) {
      imageLocalPath = fs.existsSync(portraitPathForSlug(artist.id))
        ? portraitPathForSlug(artist.id)
        : artist.imageLocalPath;
      if (!imageLocalPath) {
        console.warn(`Portrait download failed for ${artist.id}:`, imgErr.message);
      }
    }

    const biographyHtml = await generateBiographyHtml(artist, extract);
    let nationalityFields = {};
    try {
      const nationality = await resolveArtistNationality({
        ...artist,
        wikipediaUrl,
      });
      nationalityFields = {
        nationality: nationality.countryName,
        countryIso2: nationality.iso2,
        countryHandle: nationality.countryHandle,
      };
    } catch (natErr) {
      console.warn(`Nationality resolve failed for ${artist.id}:`, natErr.message);
    }
    const updated = {
      ...artist,
      wikipediaUrl,
      biographyHtml,
      imageLocalPath: imageLocalPath || portraitPathForSlug(artist.id),
      ...nationalityFields,
      enrichStatus: "enriched",
      enrichedAt: new Date().toISOString(),
      error: null,
    };
    upsertArtist(store, updated);
    saveArtistsStore(store);
    return updated;
  } catch (error) {
    const failed = {
      ...artist,
      enrichStatus: "error",
      error: error.message || String(error),
    };
    upsertArtist(store, failed);
    saveArtistsStore(store);
    throw error;
  }
}

async function enrichArtists(ids) {
  const results = { ok: [], errors: [] };
  for (const id of ids) {
    try {
      const artist = await enrichArtistById(id);
      results.ok.push({ id, name: artist.name });
    } catch (error) {
      results.errors.push({ id, error: error.message || String(error) });
    }
  }
  return { ...results, store: loadArtistsStore() };
}

module.exports = {
  wikipediaTitleCandidates,
  resolveWikipedia,
  enrichArtistById,
  enrichArtists,
  stripImagesFromHtml,
};
