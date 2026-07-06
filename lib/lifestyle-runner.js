const fs = require("fs");

const path = require("path");

const os = require("os");

const { runPool } = require("./parallel-pool");

const {

  loadCatalogStore,

  saveCatalogStore,

  getPortraitImage,

  lifestyleOutputFolderName,

} = require("./catalog-products-store");

const { ensurePythonReady, runCompositorManifest } = require("./python-setup");

const { listFramesForOrientation, normalizeFrameTemplatesPath, validateFrameTemplatesForProducts } = require("./frame-template-parser");



const job = {

  state: "idle",

  queue: [],

  nextIndex: 0,

  total: 0,

  current: 0,

  productsProcessed: 0,

  imagesCreated: 0,

  totalBytes: 0,

  errors: 0,

  concurrency: 1,

  inFlight: 0,

  stopRequested: false,

  lastProductId: null,

  lastTitle: null,

  error: null,

  store: null,

  frameTemplatesPath: null,

  outputPath: null,

  avgBytesPerImage: 0,

};



function getStatus() {

  return {

    state: job.state,

    current: job.current,

    total: job.total,

    productsProcessed: job.productsProcessed,

    imagesCreated: job.imagesCreated,

    totalBytes: job.totalBytes,

    avgBytesPerImage: job.avgBytesPerImage,

    errors: job.errors,

    concurrency: job.concurrency,

    inFlight: job.inFlight,

    lastProductId: job.lastProductId,

    lastTitle: job.lastTitle,

    error: job.error,

    frameTemplatesPath: job.frameTemplatesPath,

    outputPath: job.outputPath,

  };

}



function resetJob() {

  job.state = "idle";

  job.queue = [];

  job.nextIndex = 0;

  job.total = 0;

  job.current = 0;

  job.productsProcessed = 0;

  job.imagesCreated = 0;

  job.totalBytes = 0;

  job.errors = 0;

  job.inFlight = 0;

  job.stopRequested = false;

  job.lastProductId = null;

  job.lastTitle = null;

  job.error = null;

  job.store = null;

  job.frameTemplatesPath = null;

  job.outputPath = null;

  job.avgBytesPerImage = 0;

}



function buildQueue(store, productIds) {

  const idSet = new Set(productIds.map((id) => String(id)));

  const queue = Object.values(store.products).filter((product) => idSet.has(product.productId));

  job.queue = queue;

  job.total = queue.length;

  job.nextIndex = 0;

  return queue.length;

}



function claimNextIndex() {

  if (job.stopRequested) {

    return -1;

  }

  if (job.nextIndex >= job.queue.length) {

    return -1;

  }

  const index = job.nextIndex;

  job.nextIndex += 1;

  return index;

}



function updateAvgBytes() {

  job.avgBytesPerImage = job.imagesCreated > 0 ? Math.round(job.totalBytes / job.imagesCreated) : 0;

}



function buildFramesManifest(product) {

  const orientation = String(product.orientation || "").trim();

  if (!orientation) {

    throw new Error("Product orientation is required. Run orientation detection first.");

  }



  const { frames, skipped } = listFramesForOrientation(job.frameTemplatesPath, orientation);

  if (skipped.length) {

    job.errors += skipped.length;

  }



  return frames.map((frame) => ({

    framePath: frame.framePath,

    outputIndex: frame.outputIndex,

    room: frame.room,

    roomLabel: frame.roomLabel,

    frameTemplate: frame.frameTemplate,

  }));

}



async function processProduct(index) {

  const product = job.queue[index];

  job.inFlight += 1;

  const manifestPath = path.join(os.tmpdir(), `editpro-lifestyle-${product.productId}-${Date.now()}.json`);



  try {

    const portrait = getPortraitImage(product);

    if (!portrait?.path || !fs.existsSync(portrait.path)) {

      throw new Error("Source painting image not found.");

    }



    const frames = buildFramesManifest(product);

    const folderName = lifestyleOutputFolderName(product);

    const outputDir = path.join(job.outputPath, folderName);

    fs.mkdirSync(outputDir, { recursive: true });



    const manifest = {

      paintingPath: portrait.path,

      frames,

      outputDir,

      outputBaseName: folderName,

      size: 1080,

      jpegQuality: 88,

    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");



    const result = await runCompositorManifest(manifestPath);

    const images = result.images || [];

    const now = new Date().toISOString();



    job.store.products[product.productId] = {

      ...job.store.products[product.productId],

      lifestyleImages: images.map((img) => ({

        index: img.index,

        room: img.room || null,

        roomLabel: img.roomLabel || null,

        filename: img.filename,

        path: img.path,

        frameTemplate: img.frameTemplate,

        generatedAt: now,

        bytes: img.bytes,

      })),

      lifestyleStatus: images.length ? "generated" : "error",

      lifestyleError: result.errors?.length

        ? result.errors.map((e) => `${e.frameTemplate}: ${e.message}`).join("; ")

        : null,

      lifestyleGeneratedAt: now,

    };



    job.imagesCreated += images.length;

    job.totalBytes += result.totalBytes || images.reduce((sum, img) => sum + (img.bytes || 0), 0);

    job.productsProcessed += 1;

    if (result.errors?.length) {

      job.errors += result.errors.length;

    }

    updateAvgBytes();

    saveCatalogStore(job.store);



    job.current += 1;

    job.lastProductId = product.productId;

    job.lastTitle = product.title || product.productId;

  } catch (error) {

    job.errors += 1;

    job.current += 1;

    job.productsProcessed += 1;

    job.store.products[product.productId] = {

      ...job.store.products[product.productId],

      lifestyleStatus: "error",

      lifestyleError: error.message || "Lifestyle generation failed.",

    };

    saveCatalogStore(job.store);

    job.lastProductId = product.productId;

    job.lastTitle = product.title || product.productId;

  } finally {

    job.inFlight -= 1;

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

  job.concurrency = 1;

  await runPool({

    concurrency: job.concurrency,

    claimIndex: claimNextIndex,

    onIndex: (index) => processProduct(index),

  });



  if (job.stopRequested) {

    job.state = "stopped";

    return;

  }



  job.state = "done";

  job.store.lifestyleSettings = {

    ...(job.store.lifestyleSettings || {}),

    frameTemplatesPath: job.frameTemplatesPath,

    outputPath: job.outputPath,

    lastRunAt: new Date().toISOString(),

  };

  saveCatalogStore(job.store);

}



async function start(options = {}) {

  if (job.state === "running") {

    const err = new Error("A lifestyle generation job is already running.");

    err.code = "JOB_RUNNING";

    throw err;

  }



  const productIds = Array.isArray(options.productIds) ? options.productIds : [];

  if (!productIds.length) {

    throw new Error("Select at least one product.");

  }



  const frameTemplatesPath = normalizeFrameTemplatesPath(options.frameTemplatesPath);
  const outputPath = String(options.outputPath || "").trim();

  if (!frameTemplatesPath) {
    throw new Error("Frame templates path is required.");
  }
  if (!outputPath) {
    throw new Error("Lifestyle output path is required.");
  }
  if (!fs.existsSync(frameTemplatesPath)) {
    throw new Error("Frame templates folder not found.");
  }

  await ensurePythonReady({ installIfMissing: true, installPackagesIfMissing: true });
  fs.mkdirSync(outputPath, { recursive: true });

  const store = loadCatalogStore();
  const idSet = new Set(productIds.map((id) => String(id)));
  const queue = Object.values(store.products).filter((product) => idSet.has(product.productId));
  if (!queue.length) {
    resetJob();
    job.state = "done";
    return getStatus();
  }

  const validatedFramePath = validateFrameTemplatesForProducts(frameTemplatesPath, queue);

  resetJob();
  job.state = "running";
  job.frameTemplatesPath = validatedFramePath;
  job.outputPath = outputPath;
  job.store = store;
  job.store.lifestyleSettings = {
    ...(job.store.lifestyleSettings || {}),
    frameTemplatesPath: validatedFramePath,
    outputPath,
  };

  job.queue = queue;
  job.total = queue.length;
  job.nextIndex = 0;



  runLoop().catch((error) => {

    job.state = "error";

    job.error = error.message || "Lifestyle generation failed.";

    saveCatalogStore(job.store);

  });



  return getStatus();

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

  stop,

};

