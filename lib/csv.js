'use strict';

/** Minimal RFC4180 CSV parser/serializer (no dependencies). */

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Parse into array of objects keyed by the header row. */
function parseCSVObjects(text) {
  const rows = parseCSV(text).filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o = {};
    header.forEach((h, idx) => { o[h] = r[idx] === undefined ? '' : r[idx]; });
    return o;
  });
}

function escapeField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** rows: array of objects; columns: array of keys. Returns CSV text with BOM for Excel. */
function toCSV(rows, columns) {
  const lines = [columns.map(escapeField).join(',')];
  for (const r of rows) lines.push(columns.map(c => escapeField(r[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { parseCSV, parseCSVObjects, toCSV };
