const { pinterestAdapter } = require("./pinterest");
const { amazonAdapter } = require("./amazon");
const { flipkartAdapter } = require("./flipkart");

const ADAPTERS = [pinterestAdapter(), amazonAdapter(), flipkartAdapter()];

function listMarketplaces() {
  return ADAPTERS.map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    format: adapter.format,
    sheetName: adapter.sheetName || null,
    defaultSampleName: adapter.defaultSampleName,
    defaultCurrency: adapter.defaultCurrency,
    notes: adapter.notes,
  }));
}

function getMarketplace(id) {
  const adapter = ADAPTERS.find((item) => item.id === id);
  if (!adapter) {
    throw new Error(`Unknown marketplace: ${id}`);
  }
  return adapter;
}

module.exports = {
  listMarketplaces,
  getMarketplace,
};
