const { loadConfig, getShopifyCredentials, getOpenAiApiKey } = require("./config-store");
const { fetchCatalog } = require("./catalog-fetcher");
const { enumerateCatalogImages, isPortraitProductImage } = require("./catalog-images");
const {
  createMutableStore,
  upsertInStore,
  flushStore,
  reconcileImageRoomMap,
  hasMappingForImage,
  getRoomForImage,
} = require("./image-room-store");
const { isNoneRoom } = require("./room-utils");
const { ensureCached, getCacheStats } = require("./image-cache");
const { detectRoomFromLocalFile } = require("./room-detector");
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
  mapped: 0,
  skipped: 0,
  portraits: 0,
  concurrency: 8,
  inFlight: 0,
  cacheHits: 0,
  cacheMisses: 0,
  pauseReason: null,
  resumeAt: null,
  lastFileId: null,
  lastRoom: null,
  lastResourceTitle: null,
  error: null,
  stopRequested: false,
  abortWorkers: false,
  pauseAfterDrain: false,
  retryQueue: [],
  mappingStore: null,
  pendingFlush: 0,
  currentPauseMs: 0,
  resumeTimer: null,
};

function getRoomOptions() {
  const config = loadConfig();
  return {
    ...(config.roomDetection || {}),
    openaiApiKey: getOpenAiApiKey(),
  };
}

function getConcurrency(opts) {
  const raw = Number(opts.openaiConcurrency);
  if (!Number.isFinite(raw) || raw < 1) {
    return 8;
  }
  return Math.min(32, Math.floor(raw));
}

function getStatus() {
  return {
    state: job.state,
    phase: job.phase,
    current: job.current,
    total: job.total,
    mapped: job.mapped,
    skipped: job.skipped,
    portraits: job.portraits,
    concurrency: job.concurrency,
    inFlight: job.inFlight,
    paused: job.state === "paused",
    pauseReason: job.pauseReason,
    resumeAt: job.resumeAt,
    lastFileId: job.lastFileId,
    lastRoom: job.lastRoom,
    lastResourceTitle: job.lastResourceTitle,
    cacheHits: job.cacheHits,
    cacheMisses: job.cacheMisses,
    error: job.error,
    cache: getCacheStats(),
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
  job.mapped = 0;
  job.skipped = 0;
  job.portraits = 0;
  job.concurrency = 8;
  job.inFlight = 0;
  job.cacheHits = 0;
  job.cacheMisses = 0;
  job.pauseReason = null;
  job.resumeAt = null;
  job.lastFileId = null;
  job.lastRoom = null;
  job.lastResourceTitle = null;
  job.error = null;
  job.stopRequested = false;
  job.abortWorkers = false;
  job.pauseAfterDrain = false;
  job.retryQueue = [];
  job.mappingStore = null;
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

async function buildQueue() {
  const { storeDomain, accessToken } = getShopifyCredentials();
  if (!storeDomain || !accessToken) {
    throw new Error("Shopify credentials missing. Connect your store in SEO Engine.");
  }
  job.phase = "catalog";
  const catalog = await fetchCatalog(storeDomain, accessToken, {});
  reconcileImageRoomMap(catalog);
  const images = enumerateCatalogImages(catalog);
  const mappingStore = createMutableStore();
  job.mappingStore = mappingStore;

  let portraitCount = 0;
  for (const img of images) {
    if (!isPortraitProductImage(img)) {
      continue;
    }
    upsertInStore(mappingStore, img, {
      room: "none",
      source: "portrait",
    });
    portraitCount += 1;
  }
  job.portraits = portraitCount;
  if (portraitCount > 0) {
    flushStore(mappingStore);
  }

  const toScan = images.filter((img) => {
    if (isPortraitProductImage(img)) {
      return false;
    }
    if (!hasMappingForImage(img, mappingStore)) {
      return true;
    }
    return isNoneRoom(getRoomForImage(img, mappingStore));
  });
  job.skipped = images.length - toScan.length;
  job.total = toScan.length;
  job.queue = toScan;
  return toScan.length;
}

function maybeFlush(force = false) {
  const opts = getRoomOptions();
  const batchSize = opts.saveBatchSize || 5;
  if (force || job.pendingFlush >= batchSize) {
    flushStore(job.mappingStore);
    job.pendingFlush = 0;
  }
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
    job.error = error.message || "Room mapping failed.";
    maybeFlush(true);
  });
}

async function processImage(index, opts) {
  const img = job.queue[index];
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

    job.phase = "cache";
    const cached = await ensureCached(img, opts);
    if (cached.fromCache) {
      job.cacheHits += 1;
    } else {
      job.cacheMisses += 1;
    }

    if (job.stopRequested || job.abortWorkers) {
      job.retryQueue.push(index);
      return;
    }

    job.phase = "detect";
    const room = await detectRoomFromLocalFile(cached.localPath, opts);

    upsertInStore(job.mappingStore, img, {
      room,
      source: "openai",
    });
    job.pendingFlush += 1;
    maybeFlush();

    job.mapped += 1;
    job.current += 1;
    job.lastFileId = img.fileId;
    job.lastRoom = room;
    job.lastResourceTitle = img.resourceTitle;

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
    job.abortWorkers = true;
    job.state = "error";
    job.error = error.message || "Room mapping failed.";
    maybeFlush(true);
  } finally {
    job.inFlight -= 1;
  }
}

async function runLoop(options) {
  const opts = { ...getRoomOptions(), ...options };
  const concurrency = getConcurrency(opts);
  job.concurrency = concurrency;
  job.phase = "detect";
  job.abortWorkers = false;
  job.pauseAfterDrain = false;

  await runPool({
    concurrency,
    claimIndex: claimNextIndex,
    onIndex: (index) => processImage(index, opts),
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

async function start() {
  if (job.state === "running" || job.state === "paused") {
    const err = new Error("A room mapping job is already running.");
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
  job.phase = "catalog";

  try {
    const queued = await buildQueue();
    if (!queued) {
      job.state = "done";
      job.phase = null;
      return getStatus();
    }
    const opts = getRoomOptions();
    runLoop(opts).catch((error) => {
      job.state = "error";
      job.error = error.message || "Room mapping failed.";
      maybeFlush(true);
    });
    return getStatus();
  } catch (error) {
    resetJob();
    job.state = "error";
    job.error = error.message || "Failed to start room mapping.";
    throw error;
  }
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
