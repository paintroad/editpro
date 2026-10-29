const path = require("path");
const { loadSettings } = require("../../lib/catalog-pipeline");
const { NEW_SETS_FOLDER } = require("../../lib/lifestyle-style");

/** All new lifestyle sets live together under the frame references folder. */
function newSetsDir() {
  return path.join(loadSettings().frameTemplatesPath, NEW_SETS_FOLDER);
}

module.exports = { NEW_SETS_FOLDER, newSetsDir };
