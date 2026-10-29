const sharp = require("sharp");

// Hard ceiling for any image sent to OpenAI: longest side never exceeds this.
const OPENAI_IMAGE_MAX_SIDE = 1080;

/**
 * Downscale an image (path or buffer) for an OpenAI vision request and return a JPEG buffer.
 * `maxWidth` can shrink it further (e.g. 512); width and height are both capped at 1080.
 */
async function openAiImageBuffer(input, { maxWidth = OPENAI_IMAGE_MAX_SIDE, quality = 85 } = {}) {
  const side = Math.min(Number(maxWidth) || OPENAI_IMAGE_MAX_SIDE, OPENAI_IMAGE_MAX_SIDE);
  return sharp(input, { limitInputPixels: false })
    .rotate()
    .resize({ width: side, height: OPENAI_IMAGE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

async function openAiImageBase64(input, options) {
  return (await openAiImageBuffer(input, options)).toString("base64");
}

module.exports = { OPENAI_IMAGE_MAX_SIDE, openAiImageBuffer, openAiImageBase64 };
