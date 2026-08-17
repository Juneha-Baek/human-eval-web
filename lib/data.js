'use strict';

/**
 * Study material loader.
 *
 * BLINDING CONTRACT
 * -----------------
 * Anything reachable from the annotator-facing API must go through
 * publicPaper() / publicPair(). Those functions build a fresh object containing
 * only annotator-visible fields. Pipeline output (`extracted_concepts`), the
 * HE2 key (stratum / sense ids / pipeline_same) and author-side columns are
 * kept in separate maps that the annotator router never touches.
 */

const fs = require('fs');
const path = require('path');
const { parseCSVObjects } = require('./csv');

const ROOT = path.join(__dirname, '..');
const HE_DIR = path.join(ROOT, 'human_eval');

function readCSV(name) {
  const file = path.join(HE_DIR, name);
  if (!fs.existsSync(file)) throw new Error('Missing study material: ' + file);
  return parseCSVObjects(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------- HE1 papers
const he1Rows = readCSV('HE1_coverage_72.csv');
const he1KeyRows = (() => {
  try { return readCSV('HE1_key.csv'); } catch (e) { return []; }
})();
const he1KeyById = new Map(he1KeyRows.map(r => [r.paper_id, r]));

const papers = he1Rows.map((r, i) => {
  const k = he1KeyById.get(r.paper_id) || {};
  return {
    paper_id: r.paper_id,
    order: i,
    year: r.year,
    title: r.title,
    abstract: r.abstract,
    // hidden from annotators:
    _extracted_concepts: r.extracted_concepts,
    _n_concepts: r.n_concepts,
    _field: k.field || '',
    _density_tercile: k.density_tercile || '',
    _journal: k.journal || ''
  };
});
const paperById = new Map(papers.map(p => [p.paper_id, p]));

function publicPaper(p) {
  return { paper_id: p.paper_id, year: p.year, title: p.title, abstract: p.abstract };
}

// ------------------------------------------------------------------ HE2 pairs
const he2Rows = readCSV('HE2_identity_360.csv');
const he2KeyRows = (() => {
  try { return readCSV('HE2_key.csv'); } catch (e) { return []; }
})();
const he2KeyById = new Map(he2KeyRows.map(r => [r.pair_id, r]));

const pairs = he2Rows.map((r, i) => {
  const k = he2KeyById.get(r.pair_id) || {};
  const stratum = k.stratum || '';
  return {
    pair_id: r.pair_id,
    order: i,
    label_A: r.label_A,
    context_A: r.context_A,
    label_B: r.label_B,
    context_B: r.context_B,
    // hidden from annotators:
    _stratum: stratum,
    _source_type: stratum.startsWith('A_') ? 'direct'
      : stratum.startsWith('B_') ? 'closure_implied'
      : stratum.startsWith('C_') ? 'unmerged_plausible' : '',
    _pipeline_relation: stratum.startsWith('A_direct_') ? stratum.replace('A_direct_', '') : '',
    _sense_a: k.sense_a || '',
    _sense_b: k.sense_b || '',
    _pipeline_same: k.pipeline_same || ''
  };
});
const pairById = new Map(pairs.map(p => [p.pair_id, p]));

function publicPair(p) {
  return {
    pair_id: p.pair_id,
    A: { label: p.label_A, context: p.context_A },
    B: { label: p.label_B, context: p.context_B }
  };
}

module.exports = {
  papers, paperById, publicPaper,
  pairs, pairById, publicPair,
  he1Fields: [...new Set(papers.map(p => p._field))].filter(Boolean),
  he2Strata: [...new Set(pairs.map(p => p._stratum))].filter(Boolean)
};
