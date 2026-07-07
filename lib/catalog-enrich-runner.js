const { loadConfig, getOpenAiApiKey } = require("./config-store");
const {
  loadCatalogStore,
  saveCatalogStore,
  getProductsNeedingEnrichment,
} = require("./catalog-products-store");
const { enrichProductFromFile } = require("./catalog-enricher");
const { runPool } = require("./parallel-pool");
const {
  checkOverload,
  canResume,
  delay,
  nextPauseDuration,
} = require("./system-guard");

const job = {
  state: "idle",
  phase: null,
  queue: [],
  current: 0,
  nextIndex: 0,
  total: 0,
  enriched: 0,
  errors: 0,
  concurrency: 4,
  inFlight: 0,
  pauseReason: null,
  resumeAt: null,
  lastProductId: null,
  lastTitle: null,
  error: null,
  stopRequested: false,
  abortWorkers: false,
  pauseAfterDrain: false,
  retryQueue: [],
  store: null,
  pendingFlush: 0,
  currentPauseMs: 0,
  resumeTimer: null,
};

function getEnrichOptions() {
  const config = loadConfig();
  return {
    ...(config.roomDetection || {}),
    openaiApiKey: getOpenAiApiKey(),
  };
}

function getConcurrency(opts) {
  const raw = Number(opts.openaiConcurrency);
  if (!Number.isFinite(raw) || raw < 1) {
    return 4;
  }
  return Math.min(32, Math.floor(raw));
}

function maybeFlush(force = false) {
  const opts = getEnrichOptions();
  const batchSize = opts.saveBatchSize || 5;
  if (force || job.pendingFlush >= batchSize) {
    saveCatalogStore(job.store);
    job.pendingFlush = 0;
  }
}

function getStatus() {
  return {
    state: job.state,
    phase: job.phase,
    current: job.current,
    total: job.total,
    enriched: job.enriched,
    errors: job.errors,
    concurrency: job.concurrency,
    inFlight: job.inFlight,
    paused: job.state === "paused",
    pauseReason: job.pauseReason,
    resumeAt: job.resumeAt,
    lastProductId: job.lastProductId,
    lastTitle: job.lastTitle,
    error: job.error,
  };
}

function resetJob() {
  if (job.resumeTimer) {
    clearTimeout(job.resumeTimer);
    job.resumeTimer = null;
  }
  job.state = "idle";
  job.phase = null;
  job.queue = [];
  job.current = 0;
  job.nextIndex = 0;
  job.total = 0;
  job.enriched = 0;
  job.errors = 0;
  job.concurrency = 4;
  job.inFlight = 0;
  job.pauseReason = null;
  job.resumeAt = null;
  job.lastProductId = null;
  job.lastTitle = null;
  job.error = null;
  job.stopRequested = false;
  job.abortWorkers = false;
  job.pauseAfterDrain = false;
  job.retryQueue = [];
  job.store = null;
  job.pendingFlush = 0;
  job.currentPauseMs = 0;
}

function claimNextIndex() {
  if (job.stopRequested || job.abortWorkers) {
    return -1;
  }
  if (job.retryQueue.length > 0) {
    return job.retryQueue.shift();
  }
  if (job.nextIndex >= job.queue.length) {
    return -1;
  }
  const index = job.nextIndex;
  job.nextIndex += 1;
  return index;
}

function isRetryableError(error) {
  const status = error.status;
  const message = error.message || "";
  return status === 429 || status === 503 || /timeout|OpenAI|rate limit/i.test(message);
}

function buildQueue(store, productIds = null) {
  let pending = getProductsNeedingEnrichment(store);
  if (Array.isArray(productIds) && productIds.length > 0) {
    const idSet = new Set(productIds.map((id) => String(id)));
    pending = pending.filter((p) => idSet.has(p.productId));
  }
  job.queue = pending;
  job.total = pending.length;
  job.nextIndex = 0;
  return pending.length;
}

async function pauseJob(reason, options) {
  job.state = "paused";
  job.pauseReason = reason;
  job.currentPauseMs = nextPauseDuration(job.currentPauseMs, options);
  job.resumeAt = new Date(Date.now() + job.currentPauseMs).toISOString();
  maybeFlush(true);
  await delay(500);
  scheduleResume(options);
}

function scheduleResume(options) {
  if (job.resumeTimer) {
    clearTimeout(job.resumeTimer);
  }
  job.resumeTimer = setTimeout(() => {
    job.resumeTimer = null;
    tryResume(options);
  }, job.currentPauseMs || options.pauseDurationMs || 120000);
}

async function tryResume(options) {
  if (job.state !== "paused" || job.stopRequested) {
    return;
  }
  const resumeCheck = canResume(options);
  if (!resumeCheck.ready) {
    job.pauseReason = resumeCheck.reason;
    job.currentPauseMs = nextPauseDuration(job.currentPauseMs, options);
    job.resumeAt = new Date(Date.now() + job.currentPauseMs).toISOString();
    scheduleResume(options);
    return;
  }
  job.state = "running";
  job.pauseReason = null;
  job.resumeAt = null;
  job.currentPauseMs = options.pauseDurationMs || 120000;
  job.abortWorkers = false;
  job.pauseAfterDrain = false;
  runLoop(options).catch((error) => {
    job.state = "error";
    job.error = error.message || "Catalog enrichment failed.";
    maybeFlush(true);
  });
}

async function processProduct(index, opts) {
  const product = job.queue[index];
  job.inFlight += 1;
  try {
    const overload = checkOverload(opts);
    if (overload.overloaded) {
      job.retryQueue.push(index);
      job.abortWorkers = true;
      job.pauseAfterDrain = true;
      job.pauseReason = overload.reason;
      return;
    }

    const portrait = product.images?.find((img) => img.index === 0);
    if (!portrait?.path) {
      throw new Error("Portrait image (_0) not found.");
    }

    job.phase = "enrich";
    const fields = await enrichProductFromFile(portrait.path, product.productId, opts, job.store, product);

    job.store.products[product.productId] = {
      ...job.store.products[product.productId],
      ...fields,
    };
    job.pendingFlush += 1;
    maybeFlush();

    job.enriched += 1;
    job.current += 1;
    job.lastProductId = product.productId;
    job.lastTitle = fields.title;

    if (opts.scanDelayMs > 0) {
      await delay(opts.scanDelayMs);
    }
  } catch (error) {
    if (isRetryableError(error)) {
      job.retryQueue.push(index);
      job.abortWorkers = true;
      job.pauseAfterDrain = true;
      job.pauseReason = error.message || "OpenAI rate limit.";
      return;
    }
    job.errors += 1;
    job.current += 1;
    job.store.products[product.productId] = {
      ...job.store.products[product.productId],
      status: "error",
      error: error.message || "Enrichment failed.",
    };
    job.pendingFlush += 1;
    maybeFlush();
    job.lastProductId = product.productId;
    job.lastTitle = null;
  } finally {
    job.inFlight -= 1;
  }
}

async function runLoop(options) {
  const opts = { ...getEnrichOptions(), ...options };
  const concurrency = getConcurrency(opts);
  job.concurrency = concurrency;
  job.phase = "enrich";
  job.abortWorkers = false;
  job.pauseAfterDrain = false;

  await runPool({
    concurrency,
    claimIndex: claimNextIndex,
    onIndex: (index) => processProduct(index, opts),
  });

  if (job.state === "error") {
    return;
  }

  if (job.stopRequested) {
    job.state = "stopped";
    maybeFlush(true);
    return;
  }

  if (job.pauseAfterDrain) {
    await pauseJob(job.pauseReason || "Paused", opts);
    return;
  }

  if (job.nextIndex >= job.queue.length && job.retryQueue.length === 0) {
    job.state = "done";
    job.phase = null;
    maybeFlush(true);
  }
}

async function start(options = {}) {
  if (job.state === "running" || job.state === "paused") {
    const err = new Error("A catalog enrichment job is already running.");
    err.code = "JOB_RUNNING";
    throw err;
  }

  if (!getOpenAiApiKey()) {
    throw new Error(
      "OpenAI API key is not configured. Set OPENAI_API_KEY or save a key in Room Map settings."
    );
  }

  resetJob();
  job.state = "running";
  job.phase = "queue";
  job.store = loadCatalogStore();

  const productIds = Array.isArray(options.productIds) ? options.productIds : null;
  const queued = buildQueue(job.store, productIds);
  if (!queued) {
    job.state = "done";
    job.phase = null;
    return getStatus();
  }

  const opts = getEnrichOptions();
  runLoop(opts).catch((error) => {
    job.state = "error";
    job.error = error.message || "Catalog enrichment failed.";
    saveCatalogStore(job.store);
  });
  return getStatus();
}

function stop() {
  if (job.state !== "running" && job.state !== "paused") {
    return getStatus();
  }
  job.stopRequested = true;
  job.abortWorkers = true;
  if (job.state === "paused" && job.resumeTimer) {
    clearTimeout(job.resumeTimer);
    job.resumeTimer = null;
    job.state = "stopped";
    maybeFlush(true);
  }
  return getStatus();
}

module.exports = {
  getStatus,
  start,
  stop,
  resetJob,
};
