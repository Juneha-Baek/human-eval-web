'use strict';

/**
 * Human Evaluation annotation server.
 *
 *   HE1 — Concept Coverage   (span highlighting on title+abstract)
 *   HE2 — Concept Identity   (pairwise same/different + relation)
 *
 * No external dependencies: node stdlib only. Storage is flat JSON under ./data.
 *
 * Blinding: the annotator-facing API (/api/*) never reads hidden fields
 * (pipeline extraction, stratum, sense ids, pipeline_same). Those live behind
 * /api/admin/* which requires the admin token.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const data = require('./lib/data');
const { buildHE1Queue, buildHE2Queue } = require('./lib/queue');
const { toCSV } = require('./lib/csv');
const stats = require('./lib/stats');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// Environment overrides so the same code runs on a PaaS (Render, Railway, Fly, Docker).
if (process.env.PORT) cfg.port = Number(process.env.PORT);
if (process.env.HOST) cfg.host = process.env.HOST;
if (process.env.ADMIN_TOKEN) cfg.adminToken = process.env.ADMIN_TOKEN;
if (process.env.ACCESS_CODE) cfg.accessCode = process.env.ACCESS_CODE;
// (storage location is set with the DATA_DIR environment variable — see lib/store.js)
const PROTOCOL = JSON.parse(fs.readFileSync(path.join(ROOT, 'protocol', 'definitions.json'), 'utf8'));
const TRAINING = JSON.parse(fs.readFileSync(path.join(ROOT, 'protocol', 'training.json'), 'utf8'));

store.init();

// --------------------------------------------------------------- secret/cookies
const secretFile = store.p('secret.txt');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), 'utf8');
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

function sign(value) {
  const mac = crypto.createHmac('sha256', SECRET).update(value).digest('hex').slice(0, 32);
  return value + '.' + mac;
}
function unsign(signed) {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = crypto.createHmac('sha256', SECRET).update(value).digest('hex').slice(0, 32);
  const given = signed.slice(i + 1);
  if (given.length !== expected.length) return null;   // timingSafeEqual requires equal lengths
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ? value : null;
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, days, req) {
  const maxAge = days * 24 * 3600;
  // behind an HTTPS proxy (tunnel / PaaS) mark the session cookie Secure
  const https = req && (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.setHeader('Set-Cookie', (res.getHeader('Set-Cookie') || []).concat(
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`
  ));
}

// --------------------------------------------------------------- annotators
function annotators() { return store.readJSON(store.p('annotators.json'), {}); }
function saveAnnotators(a) { store.writeJSON(store.p('annotators.json'), a); }

const ID_RE = /^[A-Za-z0-9_-]{2,40}$/;

function ensureAnnotator(id) {
  const all = annotators();
  if (!all[id]) {
    all[id] = {
      annotator_id: id,
      created_at: new Date().toISOString(),
      consent_at: null,
      training: { answers: {}, completed_at: null, n_correct: 0 },
      last_seen: null
    };
  }
  all[id].last_seen = new Date().toISOString();
  saveAnnotators(all);
  ensureQueues(id);
  return all[id];
}

function queuePath(task, id) { return store.p('queue', `${task}_${id}.json`); }
function annPath(task, id) { return store.p('ann', `${task}_${id}.json`); }

function ensureQueues(id) {
  const q1 = queuePath('he1', id);
  if (!fs.existsSync(q1)) store.writeJSON(q1, buildHE1Queue(id, data.papers, cfg));
  const q2 = queuePath('he2', id);
  if (!fs.existsSync(q2)) store.writeJSON(q2, buildHE2Queue(id, data.pairs, cfg));
}

function getQueue(task, id) { return store.readJSON(queuePath(task, id), []); }
function getAnn(task, id) { return store.readJSON(annPath(task, id), {}); }
function saveAnn(task, id, obj) { store.writeJSON(annPath(task, id), obj); }

function progress(task, id) {
  const q = getQueue(task, id);
  const a = getAnn(task, id);
  let done = 0;
  let next = 0;
  let seenIncomplete = false;
  q.forEach((el, i) => {
    const rec = a[String(i)];
    const complete = rec && rec.completed_at;
    if (complete) done++;
    else if (!seenIncomplete) { next = i; seenIncomplete = true; }
  });
  if (!seenIncomplete) next = Math.max(0, q.length - 1);
  return { total: q.length, done, next_idx: next, finished: done === q.length && q.length > 0 };
}

function meState(id) {
  const rec = annotators()[id];
  const he1 = progress('he1', id);
  const he2 = progress('he2', id);
  const trainingDone = !!(rec.training && rec.training.completed_at);
  return {
    annotator_id: id,
    consent_at: rec.consent_at,
    consent_required: !!cfg.requireConsent,
    training_required: !!cfg.requireTraining,
    training_done: trainingDone,
    training_total: TRAINING.items.length,
    training_answered: Object.keys((rec.training && rec.training.answers) || {}).length,
    enforce_task_order: !!cfg.enforceTaskOrder,
    he1, he2,
    he2_unlocked: !cfg.enforceTaskOrder || he1.finished,
    tasks_unlocked: (!cfg.requireConsent || !!rec.consent_at) && (!cfg.requireTraining || trainingDone),
    protocol_version: PROTOCOL.version,
    study_title: cfg.studyTitle
  };
}

// --------------------------------------------------------------- http helpers
function send(res, code, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  res.writeHead(code, h);
  res.end(body);
}
function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => {
      buf += c;
      if (buf.length > 4e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
  const ext = path.extname(file).toLowerCase();
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[ext] || 'application/octet-stream' });
}

// --------------------------------------------------------------- auth guards
function currentAnnotator(req) {
  const c = parseCookies(req);
  const id = unsign(c.hev_session || '');
  if (!id || !ID_RE.test(id)) return null;
  const all = annotators();
  return all[id] ? id : null;
}
function isAdmin(req) {
  const c = parseCookies(req);
  if (unsign(c.hev_admin || '') === 'admin') return true;
  const hdr = req.headers['x-admin-token'];
  return !!hdr && hdr === cfg.adminToken;
}

// --------------------------------------------------------------- HE1 handlers
function he1Item(id, idx) {
  const q = getQueue('he1', id);
  if (idx < 0 || idx >= q.length) return null;
  const el = q[idx];
  const paper = data.paperById.get(el.item_id);
  const rec = getAnn('he1', id)[String(idx)] || null;
  return {
    idx, total: q.length,
    paper: data.publicPaper(paper),          // blinded view: title/abstract/year only
    saved: rec ? {
      annotations: rec.annotations || [],
      no_concepts: !!rec.no_concepts,
      notes: rec.notes || '',
      completed_at: rec.completed_at || null,
      response_time_ms: rec.response_time_ms || 0
    } : null
  };
}

function he1Save(id, body) {
  const q = getQueue('he1', id);
  const idx = Number(body.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= q.length) throw new Error('bad idx');
  const el = q[idx];
  const all = getAnn('he1', id);
  const key = String(idx);
  const prev = all[key] || {
    paper_id: el.item_id, queue_idx: idx, is_duplicate: el.is_duplicate,
    dup_of_idx: el.dup_of_idx, first_opened_at: new Date().toISOString(),
    response_time_ms: 0, visits: 0
  };
  const anns = Array.isArray(body.annotations) ? body.annotations : [];
  const paper = data.paperById.get(el.item_id);
  const abs = paper.abstract || '';
  // Two kinds of annotation: a span dragged in the abstract, and a concept the
  // annotator typed in their own wording (no offsets — the concept is what is
  // recorded, not the string).
  const clean = [];
  anns.forEach((a, i) => {
    const s = Number(a.start), e = Number(a.end);
    const hasSpan = Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= abs.length && e > s;
    const label = (a.label || (hasSpan ? abs.slice(s, e) : '')).toString().trim().slice(0, 300);
    if (!hasSpan && !label) return;
    clean.push({
      annotation_id: a.annotation_id || `${el.item_id}#${idx}#${i}#${Date.now().toString(36)}`,
      span_start: hasSpan ? s : null,
      span_end: hasSpan ? e : null,
      raw_span: hasSpan ? abs.slice(s, e) : '',
      label,
      source: hasSpan ? 'span' : 'typed',
      created_at: a.created_at || new Date().toISOString()
    });
  });
  clean.sort((a, b) => (a.span_start === null ? Infinity : a.span_start) - (b.span_start === null ? Infinity : b.span_start));

  all[key] = Object.assign(prev, {
    paper_id: el.item_id,
    queue_idx: idx,
    is_duplicate: el.is_duplicate,
    dup_of_idx: el.dup_of_idx,
    annotations: clean,
    no_concepts: !!body.no_concepts,
    notes: (body.notes || '').toString().slice(0, 2000),
    response_time_ms: (prev.response_time_ms || 0) + Math.max(0, Math.min(3600000, Number(body.elapsed_ms) || 0)),
    visits: (prev.visits || 0) + 1,
    updated_at: new Date().toISOString(),
    completed_at: body.complete ? new Date().toISOString() : (prev.completed_at || null)
  });
  saveAnn('he1', id, all);
  store.appendEvent({ t: new Date().toISOString(), task: 'HE1', annotator_id: id, idx, paper_id: el.item_id, n: clean.length, complete: !!body.complete });
  return { ok: true, progress: progress('he1', id) };
}

// --------------------------------------------------------------- HE2 handlers
function he2Item(id, idx) {
  const q = getQueue('he2', id);
  if (idx < 0 || idx >= q.length) return null;
  const el = q[idx];
  const pair = data.pairById.get(el.item_id);
  const pub = data.publicPair(pair);         // blinded view: labels + contexts only
  const left = el.flip ? pub.B : pub.A;
  const right = el.flip ? pub.A : pub.B;
  const rec = getAnn('he2', id)[String(idx)] || null;
  return {
    idx, total: q.length,
    left, right,
    saved: rec ? {
      identity_judgment: rec.identity_judgment || null,
      relation_judgment: rec.relation_judgment || null,
      direction_displayed: rec.direction_displayed || null,
      notes: rec.notes || '',
      completed_at: rec.completed_at || null
    } : null
  };
}

const IDENTITY_VALUES = ['SAME', 'DIFFERENT', 'CANNOT'];
const RELATION_VALUES = ['BN', 'PW', 'RE', 'UN', 'CANNOT'];
const DIRECTION_VALUES = ['LEFT', 'RIGHT', 'CANNOT'];

function he2Save(id, body) {
  const q = getQueue('he2', id);
  const idx = Number(body.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= q.length) throw new Error('bad idx');
  const el = q[idx];
  const identity = IDENTITY_VALUES.includes(body.identity) ? body.identity : null;
  const relation = identity === 'DIFFERENT' && RELATION_VALUES.includes(body.relation) ? body.relation : null;
  const dirDisp = (relation === 'BN' || relation === 'PW') && DIRECTION_VALUES.includes(body.direction) ? body.direction : null;

  // map displayed side back to the canonical A/B of the source material
  let dirCanon = null;
  if (dirDisp === 'CANNOT') dirCanon = 'CANNOT';
  else if (dirDisp === 'LEFT') dirCanon = el.flip ? 'B' : 'A';
  else if (dirDisp === 'RIGHT') dirCanon = el.flip ? 'A' : 'B';

  const all = getAnn('he2', id);
  const key = String(idx);
  const prev = all[key] || {
    pair_id: el.item_id, queue_idx: idx, is_duplicate: el.is_duplicate,
    dup_of_idx: el.dup_of_idx, first_opened_at: new Date().toISOString(),
    response_time_ms: 0, visits: 0
  };
  const complete = !!body.complete && !!identity && (identity !== 'DIFFERENT' || !!relation);

  all[key] = Object.assign(prev, {
    pair_id: el.item_id,
    queue_idx: idx,
    is_duplicate: el.is_duplicate,
    dup_of_idx: el.dup_of_idx,
    displayed_left: el.flip ? 'B' : 'A',
    identity_judgment: identity,
    relation_judgment: relation,
    direction_displayed: dirDisp,
    direction: dirCanon,
    notes: (body.notes || '').toString().slice(0, 2000),
    response_time_ms: (prev.response_time_ms || 0) + Math.max(0, Math.min(3600000, Number(body.elapsed_ms) || 0)),
    visits: (prev.visits || 0) + 1,
    updated_at: new Date().toISOString(),
    completed_at: complete ? new Date().toISOString() : (prev.completed_at || null)
  });
  saveAnn('he2', id, all);
  store.appendEvent({ t: new Date().toISOString(), task: 'HE2', annotator_id: id, idx, pair_id: el.item_id, identity, relation, complete });
  return { ok: true, progress: progress('he2', id) };
}

// --------------------------------------------------------------- admin views
function allAnnotatorIds() { return Object.keys(annotators()); }

function adminOverview() {
  const rows = allAnnotatorIds().map(id => {
    const rec = annotators()[id];
    const h1 = progress('he1', id);
    const h2 = progress('he2', id);
    const a1 = getAnn('he1', id);
    const a2 = getAnn('he2', id);
    const spans = Object.values(a1).reduce((s, r) => s + ((r.annotations || []).length), 0);
    const t1 = Object.values(a1).reduce((s, r) => s + (r.response_time_ms || 0), 0);
    const t2 = Object.values(a2).reduce((s, r) => s + (r.response_time_ms || 0), 0);
    return {
      annotator_id: id,
      created_at: rec.created_at,
      last_seen: rec.last_seen,
      consent_at: rec.consent_at,
      training_completed_at: rec.training && rec.training.completed_at,
      training_score: rec.training ? `${rec.training.n_correct}/${TRAINING.items.length}` : '',
      he1_done: h1.done, he1_total: h1.total, he1_spans: spans,
      he2_done: h2.done, he2_total: h2.total,
      he1_minutes: Math.round(t1 / 60000), he2_minutes: Math.round(t2 / 60000)
    };
  });
  return {
    study_title: cfg.studyTitle,
    protocol_version: PROTOCOL.version,
    n_papers: data.papers.length,
    n_pairs: data.pairs.length,
    annotators: rows
  };
}

/** HE2 judgments keyed by pair_id -> {annotator_id: record}. Duplicates: first pass wins, repeats kept separately. */
function he2ByPair() {
  const map = new Map();
  for (const id of allAnnotatorIds()) {
    const a = getAnn('he2', id);
    for (const rec of Object.values(a)) {
      if (!rec.completed_at) continue;
      if (!map.has(rec.pair_id)) map.set(rec.pair_id, {});
      const slot = map.get(rec.pair_id);
      if (rec.is_duplicate) {
        slot[id + '__repeat'] = rec;
      } else {
        slot[id] = rec;
      }
    }
  }
  return map;
}

function he1ByPaper() {
  const map = new Map();
  for (const id of allAnnotatorIds()) {
    const a = getAnn('he1', id);
    for (const rec of Object.values(a)) {
      if (!map.has(rec.paper_id)) map.set(rec.paper_id, {});
      const slot = map.get(rec.paper_id);
      if (rec.is_duplicate) slot[id + '__repeat'] = rec; else slot[id] = rec;
    }
  }
  return map;
}

function agreementReport() {
  const ids = allAnnotatorIds();
  const out = { he2: {}, he1: {}, intra: {} };

  // ---- HE2 inter-rater
  const byPair = he2ByPair();
  const primaryPairs = [];   // [labelA, labelB] identity (3-way)
  const binaryPairs = [];    // SAME vs DIFFERENT (CANNOT excluded)
  const relationPairs = [];
  const unitsPrimary = [];
  let nBoth = 0, nCannot = 0, nTotalJudg = 0;

  for (const [pid, slot] of byPair) {
    const primary = Object.entries(slot).filter(([k]) => !k.endsWith('__repeat'));
    for (const [, r] of primary) { nTotalJudg++; if (r.identity_judgment === 'CANNOT') nCannot++; }
    if (primary.length >= 2) {
      nBoth++;
      const labels = primary.map(([, r]) => r.identity_judgment);
      unitsPrimary.push(labels);
      const [a, b] = labels;
      primaryPairs.push([a, b]);
      if (a !== 'CANNOT' && b !== 'CANNOT') binaryPairs.push([a, b]);
      const relA = primary[0][1].relation_judgment, relB = primary[1][1].relation_judgment;
      if (relA && relB) relationPairs.push([relA, relB]);
    }
  }
  out.he2 = {
    pairs_with_two_annotators: nBoth,
    judgments_total: nTotalJudg,
    cannot_determine_rate: nTotalJudg ? nCannot / nTotalJudg : null,
    identity_percent_agreement: stats.percentAgreement(primaryPairs),
    identity_kappa: stats.cohensKappa(primaryPairs),
    identity_alpha: stats.krippendorffAlpha(unitsPrimary),
    same_vs_different_percent_agreement: stats.percentAgreement(binaryPairs),
    same_vs_different_kappa: stats.cohensKappa(binaryPairs),
    relation_percent_agreement: stats.percentAgreement(relationPairs),
    relation_kappa: stats.cohensKappa(relationPairs),
    n_relation_comparable: relationPairs.length
  };

  // ---- HE1 inter-rater (span overlap F1)
  const byPaper = he1ByPaper();
  const f1s = [];
  let papersBoth = 0;
  for (const [, slot] of byPaper) {
    const primary = Object.entries(slot).filter(([k]) => !k.endsWith('__repeat')).map(([, r]) => r)
      .filter(r => r.completed_at);
    if (primary.length >= 2) {
      papersBoth++;
      const A = (primary[0].annotations || []).map(a => ({ start: a.span_start, end: a.span_end, label: a.label }));
      const B = (primary[1].annotations || []).map(a => ({ start: a.span_start, end: a.span_end, label: a.label }));
      const r = stats.spanSetAgreement(A, B);
      if (r.f1 !== null) f1s.push(r.f1);
    }
  }
  const allSpanCounts = [];
  for (const id of ids) {
    const a = getAnn('he1', id);
    for (const rec of Object.values(a)) if (rec.completed_at) allSpanCounts.push((rec.annotations || []).length);
  }
  out.he1 = {
    papers_with_two_annotators: papersBoth,
    mean_span_overlap_f1: stats.mean(f1s),
    mean_concepts_per_paper: stats.mean(allSpanCounts),
    completed_paper_annotations: allSpanCounts.length
  };

  // ---- intra-rater (duplicated items)
  for (const id of ids) {
    const a2 = getAnn('he2', id);
    const byPid = {};
    for (const rec of Object.values(a2)) {
      if (!rec.completed_at) continue;
      byPid[rec.pair_id] = byPid[rec.pair_id] || [];
      byPid[rec.pair_id].push(rec);
    }
    const dupPairs = Object.values(byPid).filter(v => v.length >= 2)
      .map(v => [v[0].identity_judgment, v[1].identity_judgment]);

    const a1 = getAnn('he1', id);
    const byPaperId = {};
    for (const rec of Object.values(a1)) {
      if (!rec.completed_at) continue;
      byPaperId[rec.paper_id] = byPaperId[rec.paper_id] || [];
      byPaperId[rec.paper_id].push(rec);
    }
    const dupF1 = Object.values(byPaperId).filter(v => v.length >= 2).map(v => {
      const A = (v[0].annotations || []).map(x => ({ start: x.span_start, end: x.span_end, label: x.label }));
      const B = (v[1].annotations || []).map(x => ({ start: x.span_start, end: x.span_end, label: x.label }));
      return stats.spanSetAgreement(A, B).f1;
    });

    out.intra[id] = {
      he2_repeated_items: dupPairs.length,
      he2_identity_consistency: stats.percentAgreement(dupPairs),
      he2_identity_kappa: stats.cohensKappa(dupPairs),
      he1_repeated_papers: dupF1.length,
      he1_span_consistency_f1: stats.mean(dupF1)
    };
  }
  return out;
}

function he2Disagreements(filter) {
  const byPair = he2ByPair();
  const consensus = store.readJSON(store.p('gold', 'he2_consensus.json'), {});
  const rows = [];
  for (const [pid, slot] of byPair) {
    const primary = Object.entries(slot).filter(([k]) => !k.endsWith('__repeat'));
    if (primary.length < 2) continue;
    const [aid, arec] = primary[0], [bid, brec] = primary[1];
    const identityDisagree = arec.identity_judgment !== brec.identity_judgment;
    const relationDisagree = !!(arec.relation_judgment && brec.relation_judgment && arec.relation_judgment !== brec.relation_judgment);
    if (filter === 'identity' && !identityDisagree) continue;
    if (filter === 'relation' && !relationDisagree) continue;
    if (filter === 'any' && !identityDisagree && !relationDisagree) continue;
    const pair = data.pairById.get(pid);
    rows.push({
      pair_id: pid,
      label_A: pair.label_A, label_B: pair.label_B,
      a_id: aid, a_identity: arec.identity_judgment, a_relation: arec.relation_judgment, a_direction: arec.direction,
      b_id: bid, b_identity: brec.identity_judgment, b_relation: brec.relation_judgment, b_direction: brec.direction,
      identity_disagree: identityDisagree,
      relation_disagree: relationDisagree,
      consensus: consensus[pid] || null,
      stratum: pair._stratum, source_type: pair._source_type, pipeline_same: pair._pipeline_same
    });
  }
  rows.sort((a, b) => (b.identity_disagree - a.identity_disagree) || (b.relation_disagree - a.relation_disagree) || a.pair_id.localeCompare(b.pair_id));
  return rows;
}

// --------------------------------------------------------------- exports (CSV)
function exportHE1() {
  const rows = [];
  for (const id of allAnnotatorIds()) {
    const a = getAnn('he1', id);
    for (const rec of Object.values(a)) {
      const base = {
        annotator_id: id, paper_id: rec.paper_id, queue_idx: rec.queue_idx,
        is_duplicate_pass: rec.is_duplicate ? 1 : 0,
        no_concepts: rec.no_concepts ? 1 : 0,
        notes: rec.notes || '',
        response_time_ms: rec.response_time_ms || 0,
        completed_at: rec.completed_at || '', updated_at: rec.updated_at || ''
      };
      const anns = rec.annotations || [];
      if (!anns.length) {
        rows.push(Object.assign({ annotation_id: '', span_start: '', span_end: '', raw_span: '', edited_label: '', entry_mode: '', created_at: '' }, base));
      } else {
        for (const an of anns) {
          rows.push(Object.assign({
            annotation_id: an.annotation_id,
            span_start: an.span_start === null || an.span_start === undefined ? '' : an.span_start,
            span_end: an.span_end === null || an.span_end === undefined ? '' : an.span_end,
            raw_span: an.raw_span, edited_label: an.label,
            entry_mode: an.source || 'span',
            created_at: an.created_at
          }, base));
        }
      }
    }
  }
  return toCSV(rows, ['annotator_id', 'paper_id', 'annotation_id', 'span_start', 'span_end', 'raw_span', 'edited_label',
    'entry_mode', 'response_time_ms', 'created_at', 'queue_idx', 'is_duplicate_pass', 'no_concepts', 'notes', 'completed_at', 'updated_at']);
}

function exportHE2(includeHidden) {
  const rows = [];
  for (const id of allAnnotatorIds()) {
    const a = getAnn('he2', id);
    for (const rec of Object.values(a)) {
      const pair = data.pairById.get(rec.pair_id) || {};
      const row = {
        annotator_id: id, pair_id: rec.pair_id,
        identity_judgment: rec.identity_judgment || '',
        relation_judgment: rec.relation_judgment || '',
        direction: rec.direction || '',
        response_time_ms: rec.response_time_ms || 0,
        created_at: rec.completed_at || rec.updated_at || '',
        queue_idx: rec.queue_idx, is_duplicate_pass: rec.is_duplicate ? 1 : 0,
        displayed_left: rec.displayed_left || '', notes: rec.notes || ''
      };
      if (includeHidden) {
        row.label_A = pair.label_A; row.label_B = pair.label_B;
        row.stratum = pair._stratum; row.source_type = pair._source_type;
        row.pipeline_relation = pair._pipeline_relation; row.pipeline_same = pair._pipeline_same;
        row.sense_a = pair._sense_a; row.sense_b = pair._sense_b;
      }
      rows.push(row);
    }
  }
  const cols = ['annotator_id', 'pair_id', 'identity_judgment', 'relation_judgment', 'direction', 'response_time_ms',
    'created_at', 'queue_idx', 'is_duplicate_pass', 'displayed_left', 'notes'];
  if (includeHidden) cols.push('label_A', 'label_B', 'stratum', 'source_type', 'pipeline_relation', 'pipeline_same', 'sense_a', 'sense_b');
  return toCSV(rows, cols);
}

function exportHE1Gold() {
  const rows = [];
  for (const f of store.listFiles('gold', 'he1_')) {
    const g = store.readJSON(store.p('gold', f), null);
    if (!g) continue;
    for (const s of g.gold || []) {
      rows.push({
        paper_id: g.paper_id,
        span_start: s.start === null || s.start === undefined ? '' : s.start,
        span_end: s.end === null || s.end === undefined ? '' : s.end,
        raw_span: s.text || '',
        gold_label: s.label || s.text, source: s.source || '', adjudicator: g.adjudicator || '',
        adjudicated_at: g.updated_at || ''
      });
    }
  }
  return toCSV(rows, ['paper_id', 'span_start', 'span_end', 'raw_span', 'gold_label', 'source', 'adjudicator', 'adjudicated_at']);
}

/** Full raw snapshot: everything under DATA_DIR except the signing secret. */
function exportBackup() {
  const snapshot = {
    exported_at: new Date().toISOString(),
    protocol_version: PROTOCOL.version,
    study_title: cfg.studyTitle,
    annotators: annotators(),
    queues: {},
    annotations: {},
    gold: {},
    events: []
  };
  for (const id of allAnnotatorIds()) {
    for (const task of ['he1', 'he2']) {
      snapshot.queues[`${task}_${id}`] = getQueue(task, id);
      snapshot.annotations[`${task}_${id}`] = getAnn(task, id);
    }
  }
  for (const f of store.listFiles('gold', '')) {
    snapshot.gold[f.replace(/\.json$/, '')] = store.readJSON(store.p('gold', f), null);
  }
  try {
    const raw = fs.readFileSync(store.p('events.jsonl'), 'utf8');
    snapshot.events = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
  } catch (e) { /* no events yet */ }
  return JSON.stringify(snapshot, null, 2);
}

function exportHE2Consensus() {
  const c = store.readJSON(store.p('gold', 'he2_consensus.json'), {});
  const rows = Object.entries(c).map(([pid, v]) => {
    const pair = data.pairById.get(pid) || {};
    return {
      pair_id: pid, label_A: pair.label_A, label_B: pair.label_B,
      consensus_identity: v.identity || '', consensus_relation: v.relation || '',
      consensus_direction: v.direction || '', adjudicator: v.adjudicator || '',
      note: v.note || '', updated_at: v.updated_at || '',
      stratum: pair._stratum, source_type: pair._source_type, pipeline_same: pair._pipeline_same
    };
  });
  return toCSV(rows, ['pair_id', 'label_A', 'label_B', 'consensus_identity', 'consensus_relation', 'consensus_direction',
    'adjudicator', 'note', 'updated_at', 'stratum', 'source_type', 'pipeline_same']);
}

// --------------------------------------------------------------- routing
async function handleAPI(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // ---------- public ----------
  if (p === '/api/protocol' && method === 'GET') return sendJSON(res, 200, PROTOCOL);
  if (p === '/api/config' && method === 'GET') {
    return sendJSON(res, 200, {
      study_title: cfg.studyTitle, protocol_version: PROTOCOL.version,
      require_consent: cfg.requireConsent, require_training: cfg.requireTraining,
      enforce_task_order: cfg.enforceTaskOrder,
      require_access_code: !!cfg.accessCode
    });
  }

  if (p === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const id = (body.annotator_id || '').toString().trim();
    if (cfg.accessCode) {
      const given = (body.access_code || '').toString().trim();
      if (given !== cfg.accessCode.trim()) {
        store.appendEvent({ t: new Date().toISOString(), type: 'bad_access_code', annotator_id: id.slice(0, 40) });
        return sendJSON(res, 403, { error: 'That access code is not valid. Please check the invitation you were sent.' });
      }
    }
    if (!ID_RE.test(id)) return sendJSON(res, 400, { error: 'Annotator ID must be 2–40 characters: letters, digits, hyphen or underscore.' });
    ensureAnnotator(id);
    setCookie(res, 'hev_session', sign(id), 60, req);
    store.appendEvent({ t: new Date().toISOString(), type: 'login', annotator_id: id });
    return sendJSON(res, 200, meState(id));
  }

  if (p === '/api/logout' && method === 'POST') {
    setCookie(res, 'hev_session', '', 0, req);
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- admin ----------
  if (p === '/api/admin/login' && method === 'POST') {
    const body = await readBody(req);
    if ((body.token || '') !== cfg.adminToken) return sendJSON(res, 401, { error: 'Invalid admin token' });
    setCookie(res, 'hev_admin', sign('admin'), 7, req);
    return sendJSON(res, 200, { ok: true });
  }

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return sendJSON(res, 401, { error: 'Admin authentication required' });

    if (p === '/api/admin/overview' && method === 'GET') return sendJSON(res, 200, adminOverview());
    if (p === '/api/admin/agreement' && method === 'GET') return sendJSON(res, 200, agreementReport());

    if (p === '/api/admin/he1/papers' && method === 'GET') {
      const byPaper = he1ByPaper();
      const gold = new Set(store.listFiles('gold', 'he1_').map(f => store.readJSON(store.p('gold', f), {}).paper_id));
      const rows = data.papers.map(pp => {
        const slot = byPaper.get(pp.paper_id) || {};
        const primary = Object.entries(slot).filter(([k]) => !k.endsWith('__repeat'));
        return {
          paper_id: pp.paper_id, title: pp.title, year: pp.year,
          field: pp._field, journal: pp._journal, density_tercile: pp._density_tercile,
          n_annotators: primary.filter(([, r]) => r.completed_at).length,
          annotators: primary.map(([k, r]) => ({ id: k, n: (r.annotations || []).length, done: !!r.completed_at })),
          gold_done: gold.has(pp.paper_id)
        };
      });
      return sendJSON(res, 200, rows);
    }

    if (p === '/api/admin/he1/reconcile' && method === 'GET') {
      const pid = url.searchParams.get('paper_id');
      const pp = data.paperById.get(pid);
      if (!pp) return sendJSON(res, 404, { error: 'unknown paper' });
      const slot = he1ByPaper().get(pid) || {};
      const per = Object.entries(slot).map(([k, r]) => ({
        annotator_id: k, completed_at: r.completed_at || null, no_concepts: !!r.no_concepts,
        notes: r.notes || '',
        annotations: (r.annotations || []).map(a => ({
          start: a.span_start === undefined ? null : a.span_start,
          end: a.span_end === undefined ? null : a.span_end,
          text: a.raw_span, label: a.label, source: a.source || 'span'
        }))
      }));
      const gold = store.readJSON(store.p('gold', `he1_${encodeURIComponent(pid).replace(/[^A-Za-z0-9]/g, '_')}.json`), null);
      return sendJSON(res, 200, {
        paper: { paper_id: pp.paper_id, title: pp.title, year: pp.year, abstract: pp.abstract, field: pp._field, journal: pp._journal },
        pipeline_concepts: (pp._extracted_concepts || '').split('|').map(s => s.trim()).filter(Boolean), // adjudicator-only reference
        annotators: per,
        gold
      });
    }

    if (p === '/api/admin/he1/gold' && method === 'POST') {
      const body = await readBody(req);
      const pid = body.paper_id;
      const pp = data.paperById.get(pid);
      if (!pp) return sendJSON(res, 404, { error: 'unknown paper' });
      const file = store.p('gold', `he1_${encodeURIComponent(pid).replace(/[^A-Za-z0-9]/g, '_')}.json`);
      const gold = (body.gold || []).map(s => {
        const st = Number(s.start), en = Number(s.end);
        const hasSpan = Number.isInteger(st) && Number.isInteger(en) && st >= 0 && en <= pp.abstract.length && en > st;
        const label = (s.label || '').toString().trim().slice(0, 300);
        return {
          start: hasSpan ? st : null,
          end: hasSpan ? en : null,
          text: hasSpan ? pp.abstract.slice(st, en) : '',
          label,
          source: s.source || ''
        };
      }).filter(s => s.label || s.text);
      store.writeJSON(file, {
        paper_id: pid, gold, adjudicator: (body.adjudicator || 'admin').toString().slice(0, 60),
        note: (body.note || '').toString().slice(0, 2000), updated_at: new Date().toISOString()
      });
      return sendJSON(res, 200, { ok: true, n: gold.length });
    }

    if (p === '/api/admin/he2/disagreements' && method === 'GET') {
      return sendJSON(res, 200, he2Disagreements(url.searchParams.get('filter') || 'any'));
    }

    if (p === '/api/admin/he2/pair' && method === 'GET') {
      const pid = url.searchParams.get('pair_id');
      const pair = data.pairById.get(pid);
      if (!pair) return sendJSON(res, 404, { error: 'unknown pair' });
      const slot = he2ByPair().get(pid) || {};
      const consensus = store.readJSON(store.p('gold', 'he2_consensus.json'), {})[pid] || null;
      return sendJSON(res, 200, {
        pair: {
          pair_id: pid, label_A: pair.label_A, context_A: pair.context_A,
          label_B: pair.label_B, context_B: pair.context_B,
          stratum: pair._stratum, source_type: pair._source_type,
          pipeline_relation: pair._pipeline_relation, pipeline_same: pair._pipeline_same
        },
        judgments: Object.entries(slot).map(([k, r]) => ({
          annotator_id: k, identity: r.identity_judgment, relation: r.relation_judgment,
          direction: r.direction, notes: r.notes, response_time_ms: r.response_time_ms
        })),
        consensus
      });
    }

    if (p === '/api/admin/he2/consensus' && method === 'POST') {
      const body = await readBody(req);
      const file = store.p('gold', 'he2_consensus.json');
      const all = store.readJSON(file, {});
      if (!data.pairById.has(body.pair_id)) return sendJSON(res, 404, { error: 'unknown pair' });
      all[body.pair_id] = {
        identity: IDENTITY_VALUES.includes(body.identity) ? body.identity : null,
        relation: RELATION_VALUES.includes(body.relation) ? body.relation : null,
        direction: ['A', 'B', 'CANNOT'].includes(body.direction) ? body.direction : null,
        adjudicator: (body.adjudicator || 'admin').toString().slice(0, 60),
        note: (body.note || '').toString().slice(0, 2000),
        updated_at: new Date().toISOString()
      };
      store.writeJSON(file, all);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/admin/export' && method === 'GET') {
      const what = url.searchParams.get('what');
      const map = {
        he1: () => ['he1_annotations.csv', exportHE1()],
        he2: () => ['he2_annotations.csv', exportHE2(false)],
        he2_full: () => ['he2_annotations_with_key.csv', exportHE2(true)],
        he1_gold: () => ['he1_gold_spans.csv', exportHE1Gold()],
        he2_consensus: () => ['he2_consensus.csv', exportHE2Consensus()],
        backup: () => [`he_backup_${new Date().toISOString().slice(0, 10)}.json`, exportBackup()]
      };
      if (!map[what]) return sendJSON(res, 400, { error: 'unknown export' });
      const [name, body] = map[what]();
      return send(res, 200, body, {
        'Content-Type': what === 'backup' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`
      });
    }

    if (p === '/api/admin/reset' && method === 'POST') {
      const body = await readBody(req);
      const id = body.annotator_id;
      if (!ID_RE.test(id || '')) return sendJSON(res, 400, { error: 'bad id' });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      for (const task of ['he1', 'he2']) {
        const f = annPath(task, id);
        if (fs.existsSync(f)) fs.renameSync(f, store.p('backup', `${task}_${id}_${stamp}.json`));
        const q = queuePath(task, id);
        if (fs.existsSync(q) && body.rebuild_queue) fs.unlinkSync(q);
      }
      ensureQueues(id);
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { error: 'unknown admin endpoint' });
  }

  // ---------- annotator (session required) ----------
  const id = currentAnnotator(req);
  if (!id) return sendJSON(res, 401, { error: 'Not signed in' });

  if (p === '/api/me' && method === 'GET') return sendJSON(res, 200, meState(id));

  if (p === '/api/consent' && method === 'POST') {
    const all = annotators();
    all[id].consent_at = new Date().toISOString();
    saveAnnotators(all);
    return sendJSON(res, 200, meState(id));
  }

  if (p === '/api/training/items' && method === 'GET') {
    const rec = annotators()[id];
    const given = (rec.training && rec.training.answers) || {};
    return sendJSON(res, 200, {
      items: TRAINING.items.map(it => ({
        id: it.id, block: it.block, stem: it.stem, passage: it.passage || null, pair: it.pair || null,
        question: it.question, options: it.options,
        answered: given[it.id] ? { choice: given[it.id].choice, correct: given[it.id].correct, answer: it.answer, explanation: it.explanation } : null
      })),
      completed_at: rec.training ? rec.training.completed_at : null
    });
  }

  if (p === '/api/training/answer' && method === 'POST') {
    const body = await readBody(req);
    const item = TRAINING.items.find(i => i.id === body.id);
    if (!item) return sendJSON(res, 400, { error: 'unknown training item' });
    const correct = body.choice === item.answer;
    const all = annotators();
    all[id].training = all[id].training || { answers: {}, completed_at: null, n_correct: 0 };
    all[id].training.answers[item.id] = { choice: body.choice, correct, at: new Date().toISOString() };
    all[id].training.n_correct = Object.values(all[id].training.answers).filter(a => a.correct).length;
    saveAnnotators(all);
    return sendJSON(res, 200, { correct, answer: item.answer, explanation: item.explanation });
  }

  if (p === '/api/training/complete' && method === 'POST') {
    const all = annotators();
    const t = all[id].training || { answers: {} };
    if (Object.keys(t.answers).length < TRAINING.items.length) {
      return sendJSON(res, 400, { error: 'Please work through every training example first.' });
    }
    t.completed_at = new Date().toISOString();
    all[id].training = t;
    saveAnnotators(all);
    return sendJSON(res, 200, meState(id));
  }

  const st = meState(id);
  const gateOK = st.tasks_unlocked;

  if (p === '/api/he1/state' && method === 'GET') {
    if (!gateOK) return sendJSON(res, 403, { error: 'Complete consent and training first.' });
    const q = getQueue('he1', id);
    const a = getAnn('he1', id);
    return sendJSON(res, 200, {
      progress: progress('he1', id),
      items: q.map((el, i) => ({ idx: i, done: !!(a[String(i)] && a[String(i)].completed_at), n: a[String(i)] ? (a[String(i)].annotations || []).length : 0 }))
    });
  }
  if (p === '/api/he1/item' && method === 'GET') {
    if (!gateOK) return sendJSON(res, 403, { error: 'Complete consent and training first.' });
    const it = he1Item(id, Number(url.searchParams.get('idx')));
    return it ? sendJSON(res, 200, it) : sendJSON(res, 404, { error: 'out of range' });
  }
  if (p === '/api/he1/save' && method === 'POST') {
    if (!gateOK) return sendJSON(res, 403, { error: 'Complete consent and training first.' });
    try { return sendJSON(res, 200, he1Save(id, await readBody(req))); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }

  if (p.startsWith('/api/he2/')) {
    if (!gateOK) return sendJSON(res, 403, { error: 'Complete consent and training first.' });
    if (cfg.enforceTaskOrder && !st.he1.finished) {
      return sendJSON(res, 403, { error: 'Human Evaluation 2 unlocks after Human Evaluation 1 is complete.' });
    }
    if (p === '/api/he2/state' && method === 'GET') {
      const q = getQueue('he2', id);
      const a = getAnn('he2', id);
      return sendJSON(res, 200, {
        progress: progress('he2', id),
        items: q.map((el, i) => ({ idx: i, done: !!(a[String(i)] && a[String(i)].completed_at) }))
      });
    }
    if (p === '/api/he2/item' && method === 'GET') {
      const it = he2Item(id, Number(url.searchParams.get('idx')));
      return it ? sendJSON(res, 200, it) : sendJSON(res, 404, { error: 'out of range' });
    }
    if (p === '/api/he2/save' && method === 'POST') {
      try { return sendJSON(res, 200, he2Save(id, await readBody(req))); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
  }

  return sendJSON(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleAPI(req, res, url).catch(err => {
      console.error(err);
      sendJSON(res, 500, { error: 'Server error: ' + err.message });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`\n  ${cfg.studyTitle}`);
  console.log(`  protocol ${PROTOCOL.version} | ${data.papers.length} papers (HE1) | ${data.pairs.length} pairs (HE2)`);
  console.log(`\n  annotator:  http://localhost:${cfg.port}/`);
  console.log(`  admin:      http://localhost:${cfg.port}/admin.html`);
  if (cfg.adminToken === 'CHANGE-ME-admin-token') console.log('\n  ! set "adminToken" in config.json before deploying\n');
});
