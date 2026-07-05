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

async function fetchImageBase64(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image (${response.status}).`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
}

async function detectRoomFromImageUrl(imageUrl, options = {}) {
  const host = (options.ollamaHost || "http://localhost:11434").replace(/\/$/, "");
  const model = options.ollamaModel || "gemma3:4b";
  const roomList = ALLOWED_ROOMS.join(", ");
  const prompt =
    `This is a product lifestyle mockup showing wall art in an interior. ` +
    `Which room is shown? Reply with exactly one label from this list: ${roomList}. ` +
    `Reply with only the label, nothing else.`;

  const imageBase64 = await fetchImageBase64(imageUrl);

  let response;
  try {
    response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "user",
            content: prompt,
            images: [imageBase64],
          },
        ],
      }),
    });
  } catch (error) {
    throw new Error(
      `Cannot reach Ollama at ${host}. Start Ollama and pull a vision model, e.g. ollama pull ${model}`
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Ollama request failed (${response.status}). ${text.slice(0, 200)}`
    );
  }

  const data = await response.json();
  const content = data?.message?.content || "";
  return normalizeRoomLabel(content);
}

module.exports = {
  ALLOWED_ROOMS,
  normalizeRoomLabel,
  roomToTitleCase,
  roomToSlug,
  detectRoomFromImageUrl,
};
