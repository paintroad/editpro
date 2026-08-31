/**
 * Trial OpenAI room mapping for a limited number of unmapped lifestyle images.
 *
 * Usage:
 *   node scripts/openai-room-scan-trial.js
 *   node scripts/openai-room-scan-trial.js --limit=20
 *   node scripts/openai-room-scan-trial.js --all
 */
const roomScanRunner = require("../lib/room-scan-runner");

function parseLimit(argv) {
  if (argv.includes("--all")) {
    return null;
  }
  const flag = argv.find((a) => a.startsWith("--limit="));
  if (flag) {
    const n = Number(flag.slice("--limit=".length));
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20;
  }
  const idx = argv.indexOf("--limit");
  if (idx >= 0 && argv[idx + 1]) {
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20;
  }
  return 20;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const limit = parseLimit(process.argv.slice(2));
  console.log(
    limit == null
      ? "Starting OpenAI room-scan for ALL unmapped images…"
      : `Starting OpenAI room-scan trial (limit=${limit})…`
  );

  const started = await roomScanRunner.start({ limit });
  console.log(
    `Queued ${started.total} (of ${started.queueBeforeLimit} unmapped) · concurrency ${started.concurrency}`
  );

  let lastMapped = -1;
  let lastState = "";
  while (true) {
    const status = roomScanRunner.getStatus();
    const changed =
      status.mapped !== lastMapped ||
      status.state !== lastState ||
      status.state === "done" ||
      status.state === "error" ||
      status.state === "stopped" ||
      status.state === "paused";
    if (changed) {
      lastMapped = status.mapped;
      lastState = status.state;
      const pause =
        status.state === "paused"
          ? ` · pause=${status.pauseReason || "?"} resumeAt=${status.resumeAt || "?"}`
          : "";
      console.log(
        `[${status.state}] ${status.mapped}/${status.total}` +
          (status.lastRoom ? ` · last=${status.lastRoom} (${status.lastResourceTitle || ""})` : "") +
          ` · inFlight=${status.inFlight}` +
          ` · tokens in/out=${status.promptTokens}/${status.completionTokens}` +
          ` · ~$${status.costUsdEstimate}` +
          pause
      );
    }
    if (status.state === "done" || status.state === "error" || status.state === "stopped") {
      console.log("\n=== Final ===");
      console.log(
        JSON.stringify(
          {
            state: status.state,
            mapped: status.mapped,
            total: status.total,
            queueBeforeLimit: status.queueBeforeLimit,
            limit: status.limit,
            apiCalls: status.apiCalls,
            promptTokens: status.promptTokens,
            completionTokens: status.completionTokens,
            costUsdEstimate: status.costUsdEstimate,
            costRates: status.costRates,
            extrapolatedFullUsd:
              status.apiCalls > 0 && status.queueBeforeLimit
                ? Number(
                    (
                      (status.costUsdEstimate / status.apiCalls) *
                      status.queueBeforeLimit
                    ).toFixed(4)
                  )
                : null,
            error: status.error,
            lastRoom: status.lastRoom,
            lastResourceTitle: status.lastResourceTitle,
          },
          null,
          2
        )
      );
      if (status.state === "error") {
        process.exit(1);
      }
      break;
    }
    await sleep(1500);
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
