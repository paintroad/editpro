// Feed every detected painting through the Pipeline in batches, via the running EditPro server.
// A batch must finish before the next starts; the run stops on the first failed batch.
// If a batch is already running (e.g. after a restart of this script) it is waited for first.
//   node scripts/pipeline-prep/run_pipeline_batches.js [batchSize=100] [maxBatches]
const BASE = process.env.EDITPRO_URL || "http://localhost:3847/editpro";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `${route} ${res.status}`);
  return json;
}

// The server blocks for a while when it saves the large catalog store; ride out a few minutes of that.
async function pollStatus(route = "/api/pipeline/status") {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api("GET", route);
    } catch (error) {
      if (attempt >= 60) throw error;
      await sleep(5000);
    }
  }
}

async function waitForBatch() {
  let last = "";
  for (;;) {
    await sleep(5000);
    const status = await pollStatus();
    const line = `${status.step || ""} ${status.message || ""}`.trim();
    if (line !== last && /\b(Number|Import|Orientation|Enrich|Catalog|SEO|Shopify|Labels)\b/.test(status.step || "")) {
      if (status.step !== last.split(" ")[0]) console.log(`  ${new Date().toLocaleTimeString()} ${line}`);
      last = line;
    }
    if (status.state === "done") {
      console.log(`  ${new Date().toLocaleTimeString()} done: ${status.message}`);
      return;
    }
    if (status.state === "error") {
      console.log(`  ${new Date().toLocaleTimeString()} FAILED: ${status.error}`);
      process.exit(1);
    }
  }
}

(async () => {
  const size = Number(process.argv[2]) || 100;
  const maxBatches = Number(process.argv[3]) || Infinity;
  if ((await pollStatus()).state === "running") {
    console.log(`${new Date().toLocaleTimeString()} waiting for the running batch`);
    await waitForBatch();
  }
  for (let batch = 1; batch <= maxBatches; batch++) {
    const list = await pollStatus("/api/pipeline");
    const pending = list.items.filter((item) => item.stage !== "live").map((item) => item.fileName);
    if (!pending.length) {
      console.log("All paintings are live.");
      return;
    }
    const names = pending.slice(0, size);
    console.log(`${new Date().toLocaleTimeString()} batch ${batch}: ${names.length} of ${pending.length} remaining`);
    await api("POST", "/api/pipeline/process", { ...list.settings, fileNames: names });
    await waitForBatch();
  }
})().catch((e) => {
  console.error("FAILED", e.message);
  process.exit(1);
});
