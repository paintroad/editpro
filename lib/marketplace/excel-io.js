const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

function readWorkbook(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Sample file not found: ${filePath}`);
  }
  return XLSX.readFile(filePath, { cellDates: true, cellNF: true, cellStyles: false });
}

function sheetToRows(workbook, sheetName) {
  const name = sheetName || workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  if (!sheet) {
    throw new Error(`Sheet not found: ${name}`);
  }
  return {
    sheetName: name,
    rows: XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false }),
    sheet,
  };
}

function rowsToSheet(rows) {
  return XLSX.utils.aoa_to_sheet(rows);
}

function writeWorkbook(rowsBySheet, outputPath, bookType) {
  const workbook = XLSX.utils.book_new();
  for (const [sheetName, rows] of Object.entries(rowsBySheet)) {
    XLSX.utils.book_append_sheet(workbook, rowsToSheet(rows), sheetName.slice(0, 31));
  }
  const ext = path.extname(outputPath).toLowerCase();
  const type =
    bookType ||
    (ext === ".xls" ? "biff8" : ext === ".xlsm" ? "xlsx" : ext === ".csv" ? "csv" : "xlsx");
  XLSX.writeFile(workbook, outputPath, { bookType: type });
}

function readCsvRows(filePath) {
  const workbook = readWorkbook(filePath);
  const { rows } = sheetToRows(workbook);
  return rows;
}

function writeCsvRows(rows, outputPath) {
  const sheet = rowsToSheet(rows);
  const csv = XLSX.utils.sheet_to_csv(sheet, { forceQuotes: false });
  fs.writeFileSync(outputPath, csv, "utf8");
}

function cloneRows(rows, count) {
  return rows.map((row) => [...row]);
}

function padRow(row, length) {
  const next = [...row];
  while (next.length < length) {
    next.push("");
  }
  return next;
}

function setCell(row, index, value) {
  if (index < 0) {
    return;
  }
  if (value == null || value === "") {
    if (index >= row.length) {
      row.length = index + 1;
    }
    return;
  }
  row[index] = value;
}

function buildColumnIndex(headers, keyFn = (v) => String(v || "").trim()) {
  const map = new Map();
  headers.forEach((header, index) => {
    const key = keyFn(header);
    if (!key) {
      return;
    }
    if (!map.has(key)) {
      map.set(key, index);
    }
  });
  return map;
}

function buildColumnIndices(headers, keyFn = (v) => String(v || "").trim()) {
  const map = new Map();
  headers.forEach((header, index) => {
    const key = keyFn(header);
    if (!key) {
      return;
    }
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(index);
  });
  return map;
}

function applyRowValues(row, valuesByIndex) {
  for (const [index, value] of Object.entries(valuesByIndex)) {
    setCell(row, Number(index), value);
  }
  return row;
}

function applyKeyedValues(row, columnMap, values) {
  for (const [key, value] of Object.entries(values)) {
    const mapped = columnMap.get(key);
    if (mapped == null) {
      continue;
    }
    const indices = Array.isArray(mapped) ? mapped : [mapped];
    if (!indices.length) {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (indices[i] != null) {
          setCell(row, indices[i], item);
        }
      });
    } else {
      setCell(row, indices[0], value);
    }
  }
  return row;
}

module.exports = {
  readWorkbook,
  sheetToRows,
  writeWorkbook,
  readCsvRows,
  writeCsvRows,
  cloneRows,
  padRow,
  setCell,
  buildColumnIndex,
  buildColumnIndices,
  applyRowValues,
  applyKeyedValues,
};
