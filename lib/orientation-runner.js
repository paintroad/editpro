const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  loadCatalogStore,
  saveCatalogStore,
  getPortraitImage,
  deriveShapeFromOrientation,
  needsOrientationDetection,
} = require("./catalog-products-store");
const { ensurePythonReady, runOrientationManifest } = require("./python-setup");

const BATCH_SIZE = 50;

const job = {
  state: "idle",
  queue: [],
  queuedIds: new Set(),
  nextIndex: 0,
  total: 0,
  current: 0,
  processed: 0,
  errors: 0,
  stopRequested: false,
  lastProductId: null,
  error: null,
  store: null,
  loopPromise: null,
};

function getStatus() {
  return {
    state: job.state,
    current: job.current,
    total: job.total,
    processed: job.processed,
    errors: job.errors,
    lastProductId: job.lastProductId,
    error: job.error,
  };
}

function resetJob() {
  job.state = "idle";
  job.queue = [];
  job.queuedIds = new Set();
  job.nextIndex = 0;
  job.total = 0;
  job.current = 0;
  job.processed = 0;
  job.errors = 0;
  job.stopRequested = false;
  job.lastProductId = null;
  job.error = null;
  job.store = null;
  job.loopPromise = null;
}

function appendProductIds(productIds) {
  if (!job.store) {
    job.store = loadCatalogStore();
  }
  let added = 0;
  for (const rawId of productIds) {
    const productId = String(rawId || "").trim();
    if (!productId || job.queuedIds.has(productId)) {
      continue;
    }
    const product = job.store.products[productId];
    if (!product || !getPortraitImage(product)?.path) {
      continue;
    }
    job.queue.push(product);
    job.queuedIds.add(productId);
    added += 1;
  }
  job.total = job.queue.length;
  return added;
}

function collectMissingProductIds(store = loadCatalogStore()) {
  return Object.values(store.products || {})
    .filter((product) => needsOrientationDetection(product))
    .map((product) => product.productId);
}

async function processBatch(batch) {
  const manifestPath = path.join(
    os.tmpdir(),
    `editpro-orientation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );

  const manifest = {
    products: batch.map((product) => {
      const portrait = getPortraitImage(product);
      return {
        productId: product.productId,
        imagePath: portrait.path,
      };
    }),
  };

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    const result = await runOrientationManifest(manifestPath);
    const now = new Date().toISOString();

    for (const entry of result.results || []) {
      const productId = String(entry.productId || "").trim();
      if (!productId || !job.store.products[productId]) {
        continue;
      }

      if (entry.error || !entry.orientation) {
        job.errors += 1;
        job.store.products[productId] = {
          ...job.store.products[productId],
          orientationError: entry.error || "Orientation detection failed.",
        };
        job.lastProductId = productId;
        continue;
      }

      const shape = deriveShapeFromOrientation(entry.orientation);
      job.store.products[productId] = {
        ...job.store.products[productId],
        orientation: entry.orientation,
        shape,
        orientationDetectedAt: now,
        orientationError: null,
      };
      job.lastProductId = productId;
    }

    saveCatalogStore(job.store);
  } finally {
    try {
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
      }
    } catch {
      // ignore
    }
  }
}

async function runLoop() {
  while (!job.stopRequested && job.nextIndex < job.queue.length) {
    const batch = [];
    while (batch.length < BATCH_SIZE && job.nextIndex < job.queue.length) {
      batch.push(job.queue[job.nextIndex]);
      job.nextIndex += 1;
    }

    if (!batch.length) {
      break;
    }

    await processBatch(batch);
    job.current = job.nextIndex;
    job.processed = job.current;
  }

  if (job.stopRequested) {
    job.state = "stopped";
    return;
  }

  job.state = "done";
}

async function ensureRunning() {
  if (job.state === "running") {
    return;
  }
  if (!job.queue.length) {
    job.state = "idle";
    return;
  }

  job.state = "running";
  job.loopPromise = runLoop().catch((error) => {
    job.state = "error";
    job.error = error.message || "Orientation detection failed.";
    if (job.store) {
      saveCatalogStore(job.store);
    }
  });
}

async function start(options = {}) {
  const productIds = Array.isArray(options.productIds) ? options.productIds : null;

  await ensurePythonReady({ installIfMissing: true, installPackagesIfMissing: true });

  if (job.state === "running") {
    if (!job.store) {
      job.store = loadCatalogStore();
    }
  } else {
    resetJob();
    job.store = loadCatalogStore();
  }

  const idsToQueue = productIds?.length
    ? productIds
    : collectMissingProductIds(job.store);

  const added = appendProductIds(idsToQueue);
  if (!added && job.state !== "running") {
    job.state = "idle";
    return getStatus();
  }

  await ensureRunning();
  return getStatus();
}

async function startMissing() {
  return start({ productIds: collectMissingProductIds() });
}

function stop() {
  if (job.state !== "running") {
    return getStatus();
  }
  job.stopRequested = true;
  return getStatus();
}

module.exports = {
  getStatus,
  start,
  startMissing,
  stop,
  collectMissingProductIds,
};
