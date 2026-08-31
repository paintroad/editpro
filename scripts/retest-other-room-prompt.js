/**
 * Re-test images that OpenAI labeled "other" with a broader space prompt.
 * Observation only — does not write to image-room-map.json.
 *
 * Usage:
 *   node scripts/retest-other-room-prompt.js
 */
const fs = require("fs");
const path = require("path");
const { getOpenAiApiKey, loadConfig } = require("../lib/config-store");
const {
  ALLOWED_ROOMS,
  detectRoomFromImageUrl,
  normalizeRoomLabel,
} = require("../lib/room-detector");
const { isNoneRoom } = require("../lib/room-utils");

function estimateCostUsd(promptTokens, completionTokens) {
  return (promptTokens / 1_000_000) * 2.5 + (completionTokens / 1_000_000) * 10;
}

const MAP_PATH = path.join(process.env.USERPROFILE || "", ".editpro", "image-room-map.json");

const BROADER_PROMPT =
  "This is a product lifestyle mockup of wall art in an interior. " +
  "What area of the house, office, or space is shown? Prefer a common room name when possible " +
  "(living room, bedroom, kitchen, bathroom, dining room, office, hallway, nursery, entryway, laundry, outdoor). " +
  "If none fit, name the space in a few words (e.g. gallery wall, studio, patio, abstract close-up). " +
  "Reply with only that label.";

function loadFailedOthers() {
  const store = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  return Object.values(store.mappings || {})
    .filter(
      (e) =>
        e.source === "openai" &&
        e.room === "other" &&
        e.detectedAt &&
        e.detectedAt >= "2026-08-16T09:11:00" &&
        e.detectedAt < "2026-08-16T09:12:00" &&
        e.url
    )
    .sort((a, b) =>
      String(a.resourceTitle || "").localeCompare(String(b.resourceTitle || ""))
    );
}

(async () => {
  if (!getOpenAiApiKey()) {
    throw new Error("OpenAI API key is not configured.");
  }

  const targets = loadFailedOthers();
  if (!targets.length) {
    throw new Error("No trial 'other' images found in image-room-map.json.");
  }

  console.log(`Retesting ${targets.length} images with broader space prompt (no map write)…\n`);

  const opts = {
    ...loadConfig().roomDetection,
    openaiApiKey: getOpenAiApiKey(),
    prompt: BROADER_PROMPT,
    maxTokens: 40,
  };

  const realRooms = new Set(ALLOWED_ROOMS.filter((r) => r !== "other"));
  const rows = [];
  let promptTokens = 0;
  let completionTokens = 0;

  for (const img of targets) {
    process.stdout.write(`#${img.imageIndex} ${img.resourceTitle}… `);
    try {
      const result = await detectRoomFromImageUrl(img.url, opts);
      promptTokens += result.usage?.prompt_tokens || 0;
      completionTokens += result.usage?.completion_tokens || 0;
      const raw = result.raw || "";
      const normalized = result.room || normalizeRoomLabel(raw);
      const mapsToReal = realRooms.has(normalized) && !isNoneRoom(normalized);
      rows.push({
        title: img.resourceTitle,
        handle: img.handle,
        imageIndex: img.imageIndex,
        raw,
        normalized,
        mapsToReal,
      });
      console.log(`raw="${raw}" → normalized="${normalized}"${mapsToReal ? " ✓" : ""}`);
    } catch (error) {
      rows.push({
        title: img.resourceTitle,
        handle: img.handle,
        imageIndex: img.imageIndex,
        raw: null,
        normalized: null,
        mapsToReal: false,
        error: error.message,
      });
      console.log(`ERROR: ${error.message}`);
    }
  }

  const realCount = rows.filter((r) => r.mapsToReal).length;
  const stillOther = rows.filter((r) => r.normalized === "other" || isNoneRoom(r.normalized)).length;
  const freeForm = rows.filter(
    (r) => r.raw && !r.mapsToReal && r.normalized !== "other" && !isNoneRoom(r.normalized)
  ).length;

  console.log("\n=== Summary ===");
  console.log(
    JSON.stringify(
      {
        tested: rows.length,
        mapsToRealRoom: realCount,
        stillOtherOrNone: stillOther,
        freeFormNonCanonical: freeForm,
        promptTokens,
        completionTokens,
        costUsdEstimate: Number(estimateCostUsd(promptTokens, completionTokens).toFixed(6)),
        rows,
      },
      null,
      2
    )
  );
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
