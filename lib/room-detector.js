const fs = require("fs");
const { resizeImageUrl } = require("./image-cache");
const { getOpenAiApiKey } = require("./config-store");

const ALLOWED_ROOMS = [
  "living room",
  "bedroom",
  "kitchen",
  "bathroom",
  "dining room",
  "office",
  "hallway",
  "nursery",
  "entryway",
  "laundry",
  "outdoor",
  "other",
];

const ROOM_ALIASES = {
  lounge: "living room",
  "living-room": "living room",
  livingroom: "living room",
  bed: "bedroom",
  "dining-room": "dining room",
  diningroom: "dining room",
  "home office": "office",
  study: "office",
  corridor: "hallway",
  hall: "hallway",
  porch: "outdoor",
  patio: "outdoor",
  garden: "outdoor",
};

function normalizeRoomLabel(text) {
  if (!text) {
    return "other";
  }
  let cleaned = String(text)
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (ROOM_ALIASES[cleaned]) {
    cleaned = ROOM_ALIASES[cleaned];
  }
  if (ALLOWED_ROOMS.includes(cleaned)) {
    return cleaned;
  }
  for (const room of ALLOWED_ROOMS) {
    if (cleaned.includes(room)) {
      return room;
    }
  }
  return "other";
}

function roomToTitleCase(room) {
  return String(room || "")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function roomToSlug(room) {
  return String(room || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function readLocalImageBase64(localPath, maxBytes = 2 * 1024 * 1024) {
  const stat = fs.statSync(localPath);
  if (stat.size > maxBytes) {
    throw new Error(`Cached image too large (${Math.round(stat.size / 1024)} KB).`);
  }
  return fs.readFileSync(localPath).toString("base64");
}

async function fetchImageBase64(url, maxBytes = 2 * 1024 * 1024) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    throw new Error(`Failed to download image (${response.status}).`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`Image too large (${Math.round(buffer.length / 1024)} KB).`);
  }
  return buffer.toString("base64");
}

function buildOpenAiOptions(options) {
  const apiKey = (options.openaiApiKey || getOpenAiApiKey() || "").trim();
  const model = options.openaiModel || "gpt-4o";
  const detail = options.openaiDetail || "low";
  const timeoutMs = options.requestTimeoutMs || 90000;
  return { apiKey, model, detail, timeoutMs };
}

async function detectRoomFromBase64(imageBase64, options = {}) {
  const { apiKey, model, detail, timeoutMs } = buildOpenAiOptions(options);
  if (!apiKey) {
    throw new Error(
      "OpenAI API key is not configured. Set OPENAI_API_KEY or save a key in Room Map settings."
    );
  }

  const roomList = ALLOWED_ROOMS.join(", ");
  const prompt =
    `This is a product lifestyle mockup showing wall art in an interior. ` +
    `Which room is shown? Reply with exactly one label from this list: ${roomList}. ` +
    `Reply with only the label, nothing else.`;

  let response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        max_tokens: 20,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`,
                  detail,
                },
              },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw new Error(`Cannot reach OpenAI API. ${error.message || "Check your network connection."}`);
  }

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`OpenAI request failed (${response.status}). ${text.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return normalizeRoomLabel(content);
}

async function detectRoomFromLocalFile(localPath, options = {}) {
  const maxBytes = options.maxDownloadBytes || 2 * 1024 * 1024;
  const imageBase64 = readLocalImageBase64(localPath, maxBytes);
  return detectRoomFromBase64(imageBase64, options);
}

async function detectRoomFromImageUrl(imageUrl, options = {}) {
  const maxWidth = options.imageMaxWidth || 512;
  const maxBytes = options.maxDownloadBytes || 2 * 1024 * 1024;
  const resized = resizeImageUrl(imageUrl, maxWidth);
  const imageBase64 = await fetchImageBase64(resized, maxBytes);
  return detectRoomFromBase64(imageBase64, options);
}

module.exports = {
  ALLOWED_ROOMS,
  normalizeRoomLabel,
  roomToTitleCase,
  roomToSlug,
  detectRoomFromImageUrl,
  detectRoomFromLocalFile,
  detectRoomFromBase64,
};
