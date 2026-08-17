'use strict';

/**
 * Per-annotator item queues.
 *
 * - item order is randomized per annotator (deterministic seed -> reproducible)
 * - HE2 additionally randomizes which side (left/right) each expression is shown on
 * - a small share of items is duplicated later in the queue for intra-rater
 *   consistency; duplicates never appear back-to-back (>= minGap items apart)
 * - the queue is generated once and persisted, so resuming never reshuffles
 */

const { hashString, mulberry32, shuffled } = require('./rng');

function injectDuplicates(base, rnd, rate, minGap) {
  const n = base.length;
  const dupCount = Math.max(0, Math.round(n * rate));
  if (dupCount === 0 || n < minGap + 2) return base.slice();

  const maxSrc = Math.max(1, n - minGap - 1);
  const srcPool = shuffled(Array.from({ length: maxSrc }, (_, i) => i), rnd).slice(0, dupCount);

  const insertions = [];
  for (const c of srcPool) {
    const lo = c + minGap;
    const hi = n; // inclusive upper bound for splice position
    const pos = lo + Math.floor(rnd() * (hi - lo + 1));
    insertions.push({ pos, src: base[c] });
  }
  insertions.sort((a, b) => b.pos - a.pos);

  const out = base.slice();
  for (const ins of insertions) {
    out.splice(ins.pos, 0, Object.assign({}, ins.src, { uid: ins.src.uid + '#r', src_uid: ins.src.uid }));
  }
  return out;
}

function finalize(list) {
  const uidToIdx = new Map();
  list.forEach((el, i) => { if (!el.src_uid) uidToIdx.set(el.uid, i); });
  return list.map((el, i) => ({
    idx: i,
    uid: el.uid,
    item_id: el.item_id,
    flip: !!el.flip,
    is_duplicate: !!el.src_uid,
    dup_of_idx: el.src_uid ? (uidToIdx.has(el.src_uid) ? uidToIdx.get(el.src_uid) : null) : null
  }));
}

function buildHE1Queue(annotatorId, papers, cfg) {
  const rnd = mulberry32(hashString('HE1|' + annotatorId));
  const base = shuffled(papers.map(p => ({ uid: p.paper_id, item_id: p.paper_id })), rnd);
  const withDup = injectDuplicates(base, rnd, cfg.he1DuplicateRate, cfg.duplicateMinGap);
  return finalize(withDup);
}

function buildHE2Queue(annotatorId, pairs, cfg) {
  const rnd = mulberry32(hashString('HE2|' + annotatorId));
  const base = shuffled(pairs.map(p => ({ uid: p.pair_id, item_id: p.pair_id })), rnd)
    .map(el => Object.assign(el, { flip: rnd() < 0.5 }));
  const withDup = injectDuplicates(base, rnd, cfg.he2DuplicateRate, cfg.duplicateMinGap);
  // a repeated pair gets an independently drawn side assignment
  for (const el of withDup) if (el.src_uid) el.flip = rnd() < 0.5;
  return finalize(withDup);
}

module.exports = { buildHE1Queue, buildHE2Queue };
