'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// DATA_DIR lets a deployment point storage at a persistent disk mount.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');

const SUBDIRS = ['queue', 'ann', 'gold', 'backup'];

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const d of SUBDIRS) {
    const p = path.join(DATA_DIR, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

function p(...parts) { return path.join(DATA_DIR, ...parts); }

function readJSON(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

/**
 * Atomic-ish write: tmp file + rename.
 * On Windows the rename can intermittently fail (EPERM/EBUSY) while an indexer
 * or scanner holds the handle, so retry briefly and fall back to a direct write
 * rather than losing an annotation.
 */
function writeJSON(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(obj, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1)); // brief sync backoff
    }
  }
  fs.writeFileSync(file, payload, 'utf8'); // last resort; throws if this fails too
  console.warn('writeJSON fell back to direct write for', file, lastErr && lastErr.code);
}

function appendEvent(ev) {
  const file = p('events.jsonl');
  fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8');
}

function listFiles(subdir, prefix) {
  const dir = p(subdir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
}

module.exports = { init, p, readJSON, writeJSON, appendEvent, listFiles, DATA_DIR, ROOT };
