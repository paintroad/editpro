const fs = require("fs");
const path = require("path");
const os = require("os");
const { importCatalog } = require("./catalog-importer");
const {
  loadCatalogStore,
  saveCatalogStore,
  mergeImportResults,
} = require("./catalog-products-store");
const orientation = require("./orientation-runner");
const enrich = require("./catalog-enrich-runner");
const lifestyle = require("./lifestyle-runner");
const { buildPreviewChanges, applyChanges } = require("./catalog-seo-fix");
const { pushProducts, getPushStatus } = require("./catalog-shopify-push");

const CONFIG_DIR = path.join(os.homedir(), ".editpro");
const SETTINGS_PATH = path.join(CONFIG_DIR, "catalog-pipeline.json");
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const FRAME_SETS = { portrait: "Portrait", landscape: "Landscape", square: "Square" };

const DEFAULT_SETTINGS = {
  inputPath: "C:\\Users\\divya\\Downloads\\_New Catalog\\Output",
  frameTemplatesPath: "C:\\Users\\divya\\Downloads\\_Frame References",
  outputPath: "C:\\Users\\divya\\Downloads\\_New Generated Catalog",
};

const job = {
  state: "idle",
  step: null,
  message: "",
  current: 0,
  total: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
};

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return {
      inputPath: String(raw.inputPath || DEFAULT_SETTINGS.inputPath).trim(),
      frameTemplatesPath: String(raw.frameTemplatesPath || DEFAULT_SETTINGS.frameTemplatesPath).trim(),
      outputPath: String(raw.outputPath || DEFAULT_SETTINGS.outputPath).trim(),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(partial) {
  const current = loadSettings();
  const next = {
    inputPath: String(partial.inputPath ?? current.inputPath).trim(),
    frameTemplatesPath: String(partial.frameTemplatesPath ?? current.frameTemplatesPath).trim(),
    outputPath: String(partial.outputPath ?? current.outputPath).trim(),
  };
  if (!next.inputPath || !next.frameTemplatesPath || !next.outputPath) {
    throw new Error("Paintings, frames, and export folders are required.");
  }
  ensureConfigDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listImageFiles(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return [];
  }
  return fs
    .readdirSync(folderPath)
    .filter((name) => {
      if (name.startsWith(".")) return false;
      return IMAGE_EXT.has(path.extname(name).toLowerCase());
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function isLive(product) {
  return Boolean(product?.shopifyProductId) && product.shopifyStatus === "created";
}

function stageFor(product) {
  if (!product) return "detected";
  if (isLive(product)) return "live";
  const catalogCount = product.lifestyleImages?.length || 0;
  const failed =
    product.status === "error" ||
    product.shopifyStatus === "error" ||
    Boolean(product.orientationError) ||
    (product.lifestyleStatus === "error" && !catalogCount);
  if (failed) return "error";
  if (product.seoStatus === "fixed") return "seo";
  if (catalogCount) return "catalog";
  if (product.status === "enriched") return "enriched";
  if (product.orientation) return "oriented";
  return "imported";
}

function summarizeFile(fileName, product) {
  const stage = stageFor(product);
  const catalogCount = product?.lifestyleImages?.length || 0;
  return {
    fileName,
    productId: product?.productId || null,
    title: product?.title || "",
    orientation: product?.orientation || "",
    shape: product?.shape || "",
    enriched: product?.status === "enriched" || Boolean(product?.enrichedAt),
    catalogGenerated: catalogCount > 0,
    catalogCount,
    seoFixed: product?.seoStatus === "fixed",
    shopify:
      product?.shopifyStatus === "created"
        ? "live"
        : product?.shopifyStatus === "error"
          ? "error"
          : "pending",
    stage,
    error:
      product?.shopifyError ||
      product?.error ||
      product?.orientationError ||
      (catalogCount ? null : product?.lifestyleError) ||
      null,
  };
}

function buildList(settings = loadSettings()) {
  const store = loadCatalogStore();
  const files = listImageFiles(settings.inputPath);
  const items = files.map((fileName) => {
    const stem = path.parse(fileName).name;
    const product = /^\d+$/.test(stem) ? store.products[stem] : null;
    return summarizeFile(fileName, product);
  });
  const counts = {
    total: items.length,
    detected: 0,
    imported: 0,
    oriented: 0,
    enriched: 0,
    catalog: 0,
    seo: 0,
    live: 0,
    error: 0,
  };
  for (const item of items) {
    if (counts[item.stage] != null) counts[item.stage] += 1;
  }
  const lastAssigned = Number(store.lastAssignedProductId);
  return {
    settings,
    items,
    counts,
    nextProductId: Number.isInteger(lastAssigned) && lastAssigned > 0 ? lastAssigned + 1 : null,
    job: getStatus(),
  };
}

function getStatus() {
  return {
    state: job.state,
    step: job.step,
    message: job.message,
    current: job.current,
    total: job.total,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function resolvePreviewFile(fileName, settings = loadSettings()) {
  const root = path.resolve(settings.inputPath);
  const full = path.resolve(root, path.basename(String(fileName || "")));
  if (path.dirname(full) !== root || !IMAGE_EXT.has(path.extname(full).toLowerCase())) {
    throw new Error("Image not found.");
  }
  if (!fs.existsSync(full)) {
    throw new Error("Image not found.");
  }
  return full;
}

function currentProduct(productId) {
  return loadCatalogStore().products[String(productId)] || null;
}

function highestAssignedId(store) {
  const saved = Number(store.lastAssignedProductId);
  if (Number.isInteger(saved) && saved > 0) return saved;
  return Object.keys(store.products).reduce((max, id) => {
    const value = Number(id);
    return Number.isInteger(value) && value > max ? value : max;
  }, 0);
}

function prepareNewFiles(settings, selectedNames) {
  const store = loadCatalogStore();
  const folder = settings.inputPath;
  if (!fs.existsSync(folder)) {
    throw new Error("Paintings folder not found.");
  }
  const files = listImageFiles(folder).filter((fileName) => selectedNames.has(fileName));
  const numbered = [];
  const fresh = [];
  for (const fileName of files) {
    const stem = path.parse(fileName).name;
    if (/^\d+$/.test(stem)) {
      if (!store.products[stem]) numbered.push(fileName);
      continue;
    }
    fresh.push(fileName);
  }
  if (!numbered.length && !fresh.length) return [];

  let cursor = highestAssignedId(store);
  const assigned = [];
  for (const fileName of numbered) {
    const productId = path.parse(fileName).name;
    cursor = Math.max(cursor, Number(productId));
    assigned.push({ fileName, productId });
  }
  for (const fileName of fresh) {
    cursor += 1;
    const ext = path.extname(fileName).toLowerCase();
    const nextName = `${cursor}${ext}`;
    const from = path.join(folder, fileName);
    const to = path.join(folder, nextName);
    if (fs.existsSync(to)) {
      throw new Error(`Cannot number ${fileName}: ${nextName} already exists.`);
    }
    fs.renameSync(from, to);
    assigned.push({ fileName: nextName, productId: String(cursor) });
  }

  store.lastAssignedProductId = String(cursor);
  saveCatalogStore(store);
  return assigned.map((row) => row.productId);
}

async function importIds(settings, productIds) {
  if (!productIds.length) return;
  const imported = await importCatalog(settings.inputPath);
  const wanted = new Set(productIds.map(String));
  const products = imported.products.filter((product) => wanted.has(product.productId));
  if (products.length !== productIds.length) {
    const found = new Set(products.map((product) => product.productId));
    const missing = productIds.filter((id) => !found.has(id));
    throw new Error(`Import did not find ${missing.join(", ")}.`);
  }
  const store = loadCatalogStore();
  const previousPath = store.catalogPath;
  const previousLast = store.lastAssignedProductId;
  mergeImportResults(store, { ...imported, products });
  store.catalogPath = previousPath;
  store.lastAssignedProductId = previousLast;
  saveCatalogStore(store);
}

function pendingIds(settings, selectedNames, createdIds) {
  const store = loadCatalogStore();
  const created = new Set((createdIds || []).map(String));
  const ids = [];
  for (const fileName of listImageFiles(settings.inputPath)) {
    const stem = path.parse(fileName).name;
    if (!/^\d+$/.test(stem)) continue;
    if (!selectedNames.has(fileName) && !created.has(stem)) continue;
    const product = store.products[stem];
    if (!product || isLive(product)) continue;
    ids.push(stem);
  }
  return ids;
}

async function waitFor(step, getStepStatus) {
  for (;;) {
    const status = getStepStatus();
    job.step = step;
    job.current = Number(status.current ?? status.done ?? 0);
    job.total = Number(status.total ?? 0);
    job.message = job.total ? `${step} ${job.current}/${job.total}` : step;
    if (status.state === "done" || status.state === "idle") return status;
    if (status.state === "error" || status.state === "stopped") {
      throw new Error(status.error || `${step} ${status.state}.`);
    }
    await sleep(1000);
  }
}

function assertProducts(ids, ready, label) {
  const failed = [];
  for (const id of ids) {
    const product = currentProduct(id);
    if (!ready(product)) {
      failed.push(
        `${id}: ${product?.error || product?.orientationError || product?.lifestyleError || product?.status || "not ready"}`
      );
    }
  }
  if (failed.length) {
    throw new Error(`${label} failed for ${failed.join("; ")}`);
  }
}

async function runProcess(settings, fileNames) {
  const selectedNames = new Set(fileNames);
  job.step = "Number";
  job.message = "Numbering new paintings";
  const createdIds = prepareNewFiles(settings, selectedNames);
  if (createdIds.length) {
    job.step = "Import";
    job.message = `Importing ${createdIds.length}`;
    await importIds(settings, createdIds);
  }

  const ids = pendingIds(settings, selectedNames, createdIds);
  if (!ids.length) {
    job.message = "Selected paintings are already live.";
    return;
  }

  const needOrientation = ids.filter((id) => {
    const product = currentProduct(id);
    return product && !product.orientation;
  });
  if (needOrientation.length) {
    await orientation.start({ productIds: needOrientation });
    await waitFor("Orientation", () => orientation.getStatus());
    assertProducts(needOrientation, (product) => product?.orientation && !product.orientationError, "Orientation");
  }

  const needEnrich = ids.filter((id) => currentProduct(id)?.status !== "enriched");
  if (needEnrich.length) {
    await enrich.start({ productIds: needEnrich });
    await waitFor("Enrich", () => enrich.getStatus());
    assertProducts(needEnrich, (product) => product?.status === "enriched", "Enrich");
  }

  const needCatalog = ids.filter((id) => !(currentProduct(id)?.lifestyleImages || []).length);
  if (needCatalog.length) {
    if (!fs.existsSync(settings.frameTemplatesPath)) {
      throw new Error("Frames folder not found.");
    }
    await lifestyle.start({
      productIds: needCatalog,
      frameTemplatesPath: settings.frameTemplatesPath,
      outputPath: settings.outputPath,
      frameSets: FRAME_SETS,
    });
    await waitFor("Catalog", () => lifestyle.getStatus());
    assertProducts(
      needCatalog,
      (product) => (product?.lifestyleImages || []).length > 0,
      "Catalog"
    );
  }

  const needSeo = ids.filter((id) => currentProduct(id)?.seoStatus !== "fixed");
  if (needSeo.length) {
    job.step = "SEO";
    job.current = 0;
    job.total = needSeo.length;
    job.message = `SEO 0/${needSeo.length}`;
    const changes = buildPreviewChanges(needSeo);
    const applied = applyChanges(changes);
    if (applied.errors?.length) {
      throw new Error(applied.errors.map((row) => row.error || row.message || "SEO fix failed").join("; "));
    }
    assertProducts(needSeo, (product) => product?.seoStatus === "fixed", "SEO");
  }

  const needPush = ids.filter((id) => !isLive(currentProduct(id)));
  if (needPush.length) {
    job.step = "Shopify";
    job.message = `Shopify 0/${needPush.length}`;
    const poll = setInterval(() => {
      const status = getPushStatus();
      job.current = status.done || 0;
      job.total = status.total || needPush.length;
      job.message = `Shopify ${job.current}/${job.total}`;
    }, 1000);
    try {
      const result = await pushProducts(needPush);
      if (result.errors?.length) {
        throw new Error(result.errors.map((row) => `${row.productId}: ${row.message}`).join("; "));
      }
    } finally {
      clearInterval(poll);
    }
  }

  job.message = `Put ${ids.length} painting${ids.length === 1 ? "" : "s"} live on Shopify.`;
}

function detect(partial) {
  const settings = saveSettings(partial || {});
  if (!fs.existsSync(settings.inputPath)) {
    throw new Error("Paintings folder not found.");
  }
  return buildList(settings);
}

function startProcess(partial) {
  if (job.state === "running") {
    const error = new Error("Pipeline is already running.");
    error.code = "JOB_RUNNING";
    throw error;
  }
  const settings = saveSettings(partial || {});
  const fileNames = [
    ...new Set(
      (Array.isArray(partial?.fileNames) ? partial.fileNames : [])
        .map((name) => path.basename(String(name || "").trim()))
        .filter(Boolean)
    ),
  ];
  if (!fileNames.length) {
    throw new Error("Select at least one painting.");
  }
  if (!fs.existsSync(settings.inputPath)) {
    throw new Error("Paintings folder not found.");
  }
  job.state = "running";
  job.step = "Start";
  job.message = "Starting";
  job.current = 0;
  job.total = 0;
  job.error = null;
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;

  runProcess(settings, fileNames)
    .then(() => {
      job.state = "done";
      job.finishedAt = new Date().toISOString();
    })
    .catch((error) => {
      job.state = "error";
      job.error = error.message || "Pipeline failed.";
      job.message = job.error;
      job.finishedAt = new Date().toISOString();
    });

  return getStatus();
}

module.exports = {
  loadSettings,
  saveSettings,
  buildList,
  detect,
  startProcess,
  getStatus,
  resolvePreviewFile,
};
