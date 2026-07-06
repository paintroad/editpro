#!/usr/bin/env node
/**
 * Batch-map catalog images to rooms using OpenAI vision.
 * Usage: node scripts/map-image-rooms.js
 * Requires Shopify credentials in ~/.editpro/config.json and OPENAI_API_KEY.
 */
const roomScanRunner = require("../lib/room-scan-runner");

async function main() {
  console.log("Starting background room mapping job…");
  const startStatus = await roomScanRunner.start();
  console.log(`Queued ${startStatus.total} images (${startStatus.skipped} already mapped).`);

  if (startStatus.state === "done") {
    console.log("Nothing to map.");
    return;
  }

  await new Promise((resolve) => {
    const interval = setInterval(() => {
      const status = roomScanRunner.getStatus();
      if (status.state === "running") {
        const detail = status.lastResourceTitle
          ? ` — ${status.lastResourceTitle}`
          : "";
        process.stdout.write(
          `\r[${status.current}/${status.total}] mapped ${status.mapped}${detail}   `
        );
      } else if (status.state === "paused") {
        process.stdout.write(
          `\rPaused (${status.pauseReason}) — resumes ${status.resumeAt || "later"}   `
        );
      } else if (status.state === "done") {
        clearInterval(interval);
        console.log(`\nDone. Mapped ${status.mapped} images.`);
        resolve();
      } else if (status.state === "error") {
        clearInterval(interval);
        console.error(`\nERROR: ${status.error}`);
        process.exit(1);
      } else if (status.state === "stopped") {
        clearInterval(interval);
        console.log(`\nStopped. Mapped ${status.mapped} images.`);
        resolve();
      }
    }, 2000);
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
