'use strict';

/**
 * Human Evaluation annotation app — request handler.
 *
 *   HE1 — Concept Coverage   (spans dragged in the abstract, or concepts typed)
 *   HE2 — Concept Identity   (pairwise same/different + relation)
 *
 * Runs unchanged as a long-lived Node server (server.js) and as a serverless
 * function (api/index.js). All state lives in Supabase Postgres; nothing is
 * written to the filesystem, so an ephemeral runtime is safe.
 *
 * Blinding: the annotator-facing API never serializes hidden fields (pipeline
 * extraction, stratum, sense ids, pipeline_same). Those are reachable only
 * through /api/admin/*, which requires the admin token.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadEnv } = require('./env');
loadEnv();

const db = require('./db');
const data = require('./data');
const { buildHE1Queue, buildHE2Queue } = require('./queue');
const { toCSV } = require('./csv');
const stats = require('./stats');

/* ------------------------------------------------------------ bundled files */

function resolveRoot() {
  const candidates = [path.join(__dirname, '..'), process.cwd(), '/var/task'];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'protocol', 'definitions.json'))) return c;
  }
  return path.join(__dirname, '..');
}
const ROOT = resolveRoot();
const PUBLIC_DIR = path.join(ROOT, 'public');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
if (process.env.PORT) cfg.port = Number(process.env.PORT);
if (process.env.HOST) cfg.host = process.env.HOST;
if (process.env.ADMIN_TOKEN) cfg.adminToken = process.env.ADMIN_TOKEN;
if (process.env.ACCESS_CODE) cfg.accessCode = process.env.ACCESS_CODE;

// TASK decides which evaluation this deployment hosts. The two tasks run as
// separate sites (TASK=he1 / TASK=he2) over one shared database, so an
// annotator keeps the same ID and the coordinator sees one study.
if (process.env.TASK) cfg.task = process.env.TASK;
cfg.task = ['he1', 'he2', 'both'].includes(cfg.task) ? cfg.task : 'both';
const HOSTS = t => cfg.task === 'both' || cfg.task === t;

const PROTOCOL = JSON.parse(fs.readFileSync(path.join(ROOT, 'protocol', 'definitions.json'), 'utf8'));
const TRAINING = JSON.parse(fs.readFileSync(path.join(ROOT, 'protocol', 'training.json'), 'utf8'));

const TASK_LABEL = { he1: 'Concept Coverage', he2: 'Concept Identity' };

/** Only the training examples that belong to the task this site hosts. */
function trainingItems() {
  if (cfg.task === 'he1') return TRAINING.items.filter(i => i.block === 'Concept extraction');
  if (cfg.task === 'he2') return TRAINING.items.filter(i => i.block === 'Concept identity');
  return TRAINING.items;
}

/* --------------------------------------------------------- session cookies */

// A stable secret is required across cold starts, otherwise every annotator is
// signed out whenever a new instance boots. SESSION_SECRET is preferred; the
// derived fallback keeps a single-config deployment working.
const SECRET = process.env.SESSION_SECRET
  || (process.env.SUPABASE_SERVICE_ROLE_KEY
    ? crypto.createHash('sha256').update(process.env.SUPABASE_SERVICE_ROLE_KEY + '|hev-session').digest('hex')
    : 'dev-only-secret');

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
  if (given.length !== expected.length) return null;
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
  const proto = (req && req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = proto === 'https';
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(`${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  res.setHeader('Set-Cookie', list);
}

/* ------------------------------------------------------------- data access */

const RESP_TABLE = { he1: 'he1_responses', he2: 'he2_responses' };
const ID_RE = /^[A-Za-z0-9_-]{2,40}$/;
const nowISO = () => new Date().toISOString();

async function logEvent(payload) {
  try { await db.insert('events', [{ t: nowISO(), payload }]); } catch (e) { /* never block a save on the audit log */ }
}

async function getAnnotator(id) {
  const rows = await db.select('annotators', { eq: { annotator_id: id }, limit: 1 });
  return rows[0] || null;
}

async function listAnnotators() {
  return db.select('annotators', { order: 'annotator_id.asc' });
}

async function ensureAnnotator(id) {
  let rec = await getAnnotator(id);
  if (!rec) {
    rec = {
      annotator_id: id,
      created_at: nowISO(),
      consent_at: null,
      training: { answers: {}, completed_at: null, n_correct: 0 },
      last_seen: nowISO()
    };
    await db.upsert('annotators', [rec], { onConflict: 'annotator_id' });
  } else {
    await db.upsert('annotators', [{ annotator_id: id, last_seen: nowISO() }], { onConflict: 'annotator_id' });
  }
  await ensureQueues(id);
  return rec;
}

async function ensureQueues(id) {
  const existing = await db.select('queue_items', { eq: { annotator_id: id }, select: 'task', limit: 1 });
  if (existing.length) return;
  const he1 = buildHE1Queue(id, data.papers, cfg).map(el => ({
    annotator_id: id, task: 'he1', idx: el.idx, item_id: el.item_id,
    flip: false, is_duplicate: el.is_duplicate, dup_of_idx: el.dup_of_idx
  }));
  const he2 = buildHE2Queue(id, data.pairs, cfg).map(el => ({
    annotator_id: id, task: 'he2', idx: el.idx, item_id: el.item_id,
    flip: el.flip, is_duplicate: el.is_duplicate, dup_of_idx: el.dup_of_idx
  }));
  await db.upsert('queue_items', he1, { onConflict: 'annotator_id,task,idx' });
  await db.upsert('queue_items', he2, { onConflict: 'annotator_id,task,idx' });
}

async function queueRow(task, id, idx) {
  const rows = await db.select('queue_items', { eq: { annotator_id: id, task, idx }, limit: 1 });
  return rows[0] || null;
}

async function responseRow(task, id, idx) {
  const rows = await db.select(RESP_TABLE[task], { eq: { annotator_id: id, queue_idx: idx }, limit: 1 });
  return rows[0] || null;
}

async function progress(task, id) {
  const [queue, responses] = await Promise.all([
    db.select('queue_items', { eq: { annotator_id: id, task }, select: 'idx', order: 'idx.asc' }),
    db.select(RESP_TABLE[task], { eq: { annotator_id: id }, select: 'queue_idx,completed_at' })
  ]);
  const done = new Set(responses.filter(r => r.completed_at).map(r => Number(r.queue_idx)));
  const total = queue.length;
  let next = total ? total - 1 : 0;
  for (const q of queue) {
    if (!done.has(Number(q.idx))) { next = Number(q.idx); break; }
  }
  return { total, done: done.size, next_idx: next, finished: total > 0 && done.size === total };
}

async function meState(id) {
  const [rec, he1, he2] = await Promise.all([
    getAnnotator(id),
    HOSTS('he1') ? progress('he1', id) : Promise.resolve({ total: 0, done: 0, next_idx: 0, finished: true }),
    HOSTS('he2') ? progress('he2', id) : Promise.resolve({ total: 0, done: 0, next_idx: 0, finished: true })
  ]);
  const training = (rec && rec.training) || { answers: {} };
  const relevant = trainingItems();
  const answers = training.answers || {};
  // Completion is judged per site: an annotator who trained on the coverage
  // examples still works through the identity examples on the other site.
  const trainingDone = relevant.every(it => !!answers[it.id]);
  return {
    annotator_id: id,
    task: cfg.task,
    task_label: TASK_LABEL[cfg.task] || 'Both tasks',
    consent_at: rec ? rec.consent_at : null,
    consent_required: !!cfg.requireConsent,
    training_required: !!cfg.requireTraining,
    training_done: trainingDone,
    training_total: relevant.length,
    training_answered: relevant.filter(it => !!answers[it.id]).length,
    enforce_task_order: !!cfg.enforceTaskOrder,
    he1, he2,
    he2_unlocked: !cfg.enforceTaskOrder || he1.finished,
    tasks_unlocked: (!cfg.requireConsent || !!(rec && rec.consent_at)) && (!cfg.requireTraining || trainingDone),
    protocol_version: PROTOCOL.version,
    study_title: cfg.studyTitle
  };
}

/* ------------------------------------------------------------ http helpers */

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req) {
  if (req.body !== undefined && req.body !== null) {          // already parsed by the platform
    if (typeof req.body === 'string') {
      try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
    }
    return Promise.resolve(req.body);
  }
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
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
}

function currentAnnotator(req) {
  const id = unsign(parseCookies(req).hev_session || '');
  return id && ID_RE.test(id) ? id : null;
}
function isAdmin(req) {
  if (unsign(parseCookies(req).hev_admin || '') === 'admin') return true;
  const hdr = req.headers['x-admin-token'];
  return !!hdr && !!cfg.adminToken && hdr === cfg.adminToken;
}

/* --------------------------------------------------------------- HE1 logic */

async function he1Item(id, idx) {
  const el = await queueRow('he1', id, idx);
  if (!el) return null;
  const paper = data.paperById.get(el.item_id);
  const [rec, prog] = await Promise.all([responseRow('he1', id, idx), progress('he1', id)]);
  return {
    idx, total: prog.total,
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

async function he1Save(id, body) {
  const idx = Number(body.idx);
  if (!Number.isInteger(idx) || idx < 0) throw new Error('bad idx');
  const el = await queueRow('he1', id, idx);
  if (!el) throw new Error('bad idx');
  const prev = await responseRow('he1', id, idx);

  const paper = data.paperById.get(el.item_id);
  const abs = paper.abstract || '';
  const anns = Array.isArray(body.annotations) ? body.annotations : [];

  // Two kinds of entry: a span dragged in the abstract, and a concept typed in
  // the annotator's own wording (no offsets — the concept is what is recorded).
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
      created_at: a.created_at || nowISO()
    });
  });
  clean.sort((a, b) => (a.span_start === null ? Infinity : a.span_start) - (b.span_start === null ? Infinity : b.span_start));

  const row = {
    annotator_id: id,
    queue_idx: idx,
    paper_id: el.item_id,
    is_duplicate: !!el.is_duplicate,
    dup_of_idx: el.dup_of_idx === undefined ? null : el.dup_of_idx,
    annotations: clean,
    no_concepts: !!body.no_concepts,
    notes: (body.notes || '').toString().slice(0, 2000),
    response_time_ms: Number((prev && prev.response_time_ms) || 0) + Math.max(0, Math.min(3600000, Number(body.elapsed_ms) || 0)),
    visits: Number((prev && prev.visits) || 0) + 1,
    first_opened_at: (prev && prev.first_opened_at) || nowISO(),
    updated_at: nowISO(),
    completed_at: body.complete ? nowISO() : ((prev && prev.completed_at) || null)
  };
  await db.upsert('he1_responses', [row], { onConflict: 'annotator_id,queue_idx' });
  if (body.complete) await logEvent({ type: 'he1_complete', annotator_id: id, idx, paper_id: el.item_id, n: clean.length });
  return { ok: true, progress: await progress('he1', id) };
}

/* --------------------------------------------------------------- HE2 logic */

const IDENTITY_VALUES = ['SAME', 'DIFFERENT', 'CANNOT'];
const RELATION_VALUES = ['BN', 'PW', 'RE', 'UN', 'CANNOT'];
const DIRECTION_VALUES = ['LEFT', 'RIGHT', 'CANNOT'];

async function he2Item(id, idx) {
  const el = await queueRow('he2', id, idx);
  if (!el) return null;
  const pair = data.pairById.get(el.item_id);
  const pub = data.publicPair(pair);          // blinded view: labels + contexts only
  const [rec, prog] = await Promise.all([responseRow('he2', id, idx), progress('he2', id)]);
  return {
    idx, total: prog.total,
    left: el.flip ? pub.B : pub.A,
    right: el.flip ? pub.A : pub.B,
    saved: rec ? {
      identity_judgment: rec.identity_judgment || null,
      relation_judgment: rec.relation_judgment || null,
      direction_displayed: rec.direction_displayed || null,
      notes: rec.notes || '',
      completed_at: rec.completed_at || null
    } : null
  };
}

async function he2Save(id, body) {
  const idx = Number(body.idx);
  if (!Number.isInteger(idx) || idx < 0) throw new Error('bad idx');
  const el = await queueRow('he2', id, idx);
  if (!el) throw new Error('bad idx');
  const prev = await responseRow('he2', id, idx);

  const identity = IDENTITY_VALUES.includes(body.identity) ? body.identity : null;
  const relation = identity === 'DIFFERENT' && RELATION_VALUES.includes(body.relation) ? body.relation : null;
  const dirDisp = (relation === 'BN' || relation === 'PW') && DIRECTION_VALUES.includes(body.direction) ? body.direction : null;

  // map the displayed side back to the canonical A/B of the source material
  let dirCanon = null;
  if (dirDisp === 'CANNOT') dirCanon = 'CANNOT';
  else if (dirDisp === 'LEFT') dirCanon = el.flip ? 'B' : 'A';
  else if (dirDisp === 'RIGHT') dirCanon = el.flip ? 'A' : 'B';

  const complete = !!body.complete && !!identity && (identity !== 'DIFFERENT' || !!relation);
  const row = {
    annotator_id: id,
    queue_idx: idx,
    pair_id: el.item_id,
    is_duplicate: !!el.is_duplicate,
    dup_of_idx: el.dup_of_idx === undefined ? null : el.dup_of_idx,
    displayed_left: el.flip ? 'B' : 'A',
    identity_judgment: identity,
    relation_judgment: relation,
    direction_displayed: dirDisp,
    direction: dirCanon,
    notes: (body.notes || '').toString().slice(0, 2000),
    response_time_ms: Number((prev && prev.response_time_ms) || 0) + Math.max(0, Math.min(3600000, Number(body.elapsed_ms) || 0)),
    visits: Number((prev && prev.visits) || 0) + 1,
    first_opened_at: (prev && prev.first_opened_at) || nowISO(),
    updated_at: nowISO(),
    completed_at: complete ? nowISO() : ((prev && prev.completed_at) || null)
  };
  await db.upsert('he2_responses', [row], { onConflict: 'annotator_id,queue_idx' });
  if (complete) await logEvent({ type: 'he2_complete', annotator_id: id, idx, pair_id: el.item_id, identity, relation });
  return { ok: true, progress: await progress('he2', id) };
}

/* ------------------------------------------------------------- admin views */

async function loadAll() {
  const [annotators, he1, he2, queues] = await Promise.all([
    listAnnotators(),
    db.select('he1_responses', {}),
    db.select('he2_responses', {}),
    db.select('queue_items', { select: 'annotator_id,task,idx' })
  ]);
  return { annotators, he1, he2, queues };
}

function groupByAnnotator(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.annotator_id)) m.set(r.annotator_id, []);
    m.get(r.annotator_id).push(r);
  }
  return m;
}

async function adminOverview() {
  const { annotators, he1, he2, queues } = await loadAll();
  const qCount = new Map();
  for (const q of queues) {
    const k = q.annotator_id + '|' + q.task;
    qCount.set(k, (qCount.get(k) || 0) + 1);
  }
  const h1 = groupByAnnotator(he1), h2 = groupByAnnotator(he2);
  const rows = annotators.map(a => {
    const r1 = h1.get(a.annotator_id) || [], r2 = h2.get(a.annotator_id) || [];
    const training = a.training || {};
    return {
      annotator_id: a.annotator_id,
      created_at: a.created_at,
      last_seen: a.last_seen,
      consent_at: a.consent_at,
      training_completed_at: training.completed_at || null,
      training_score: `${training.n_correct || 0}/${Object.keys(training.answers || {}).length || TRAINING.items.length}`,
      he1_done: r1.filter(r => r.completed_at).length,
      he1_total: qCount.get(a.annotator_id + '|he1') || 0,
      he1_spans: r1.reduce((s, r) => s + ((r.annotations || []).length), 0),
      he2_done: r2.filter(r => r.completed_at).length,
      he2_total: qCount.get(a.annotator_id + '|he2') || 0,
      he1_minutes: Math.round(r1.reduce((s, r) => s + Number(r.response_time_ms || 0), 0) / 60000),
      he2_minutes: Math.round(r2.reduce((s, r) => s + Number(r.response_time_ms || 0), 0) / 60000)
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

/** pair_id -> { annotatorId: row } using first passes; repeats keyed with __repeat. */
function byItem(rows, idField) {
  const map = new Map();
  for (const r of rows) {
    if (!r.completed_at) continue;
    const key = r[idField];
    if (!map.has(key)) map.set(key, {});
    map.get(key)[r.is_duplicate ? r.annotator_id + '__repeat' : r.annotator_id] = r;
  }
  return map;
}
const firstPasses = slot => Object.entries(slot).filter(([k]) => !k.endsWith('__repeat'));

async function agreementReport() {
  const { annotators, he1, he2 } = await loadAll();
  const out = { he2: {}, he1: {}, intra: {} };

  // ---- HE2 inter-rater
  const byPair = byItem(he2, 'pair_id');
  const primaryPairs = [], binaryPairs = [], relationPairs = [], unitsPrimary = [];
  let nBoth = 0, nCannot = 0, nTotal = 0;
  for (const [, slot] of byPair) {
    const primary = firstPasses(slot);
    for (const [, r] of primary) { nTotal++; if (r.identity_judgment === 'CANNOT') nCannot++; }
    if (primary.length >= 2) {
      nBoth++;
      const labels = primary.map(([, r]) => r.identity_judgment);
      unitsPrimary.push(labels);
      primaryPairs.push([labels[0], labels[1]]);
      if (labels[0] !== 'CANNOT' && labels[1] !== 'CANNOT') binaryPairs.push([labels[0], labels[1]]);
      const relA = primary[0][1].relation_judgment, relB = primary[1][1].relation_judgment;
      if (relA && relB) relationPairs.push([relA, relB]);
    }
  }
  out.he2 = {
    pairs_with_two_annotators: nBoth,
    judgments_total: nTotal,
    cannot_determine_rate: nTotal ? nCannot / nTotal : null,
    identity_percent_agreement: stats.percentAgreement(primaryPairs),
    identity_kappa: stats.cohensKappa(primaryPairs),
    identity_alpha: stats.krippendorffAlpha(unitsPrimary),
    same_vs_different_percent_agreement: stats.percentAgreement(binaryPairs),
    same_vs_different_kappa: stats.cohensKappa(binaryPairs),
    relation_percent_agreement: stats.percentAgreement(relationPairs),
    relation_kappa: stats.cohensKappa(relationPairs),
    n_relation_comparable: relationPairs.length
  };

  // ---- HE1 inter-rater
  const toSet = r => (r.annotations || []).map(a => ({ start: a.span_start, end: a.span_end, label: a.label }));
  const byPaper = byItem(he1, 'paper_id');
  const f1s = [];
  let papersBoth = 0;
  for (const [, slot] of byPaper) {
    const primary = firstPasses(slot).map(([, r]) => r);
    if (primary.length >= 2) {
      papersBoth++;
      const r = stats.spanSetAgreement(toSet(primary[0]), toSet(primary[1]));
      if (r.f1 !== null) f1s.push(r.f1);
    }
  }
  const counts = he1.filter(r => r.completed_at).map(r => (r.annotations || []).length);
  out.he1 = {
    papers_with_two_annotators: papersBoth,
    mean_span_overlap_f1: stats.mean(f1s),
    mean_concepts_per_paper: stats.mean(counts),
    completed_paper_annotations: counts.length
  };

  // ---- intra-rater (repeated items)
  const h1 = groupByAnnotator(he1), h2 = groupByAnnotator(he2);
  for (const a of annotators) {
    const id = a.annotator_id;
    const repeats = (rows, idField) => {
      const m = new Map();
      for (const r of (rows || [])) {
        if (!r.completed_at) continue;
        if (!m.has(r[idField])) m.set(r[idField], []);
        m.get(r[idField]).push(r);
      }
      return [...m.values()].filter(v => v.length >= 2);
    };
    const dup2 = repeats(h2.get(id), 'pair_id').map(v => [v[0].identity_judgment, v[1].identity_judgment]);
    const dup1 = repeats(h1.get(id), 'paper_id').map(v => stats.spanSetAgreement(toSet(v[0]), toSet(v[1])).f1);
    out.intra[id] = {
      he2_repeated_items: dup2.length,
      he2_identity_consistency: stats.percentAgreement(dup2),
      he2_identity_kappa: stats.cohensKappa(dup2),
      he1_repeated_papers: dup1.length,
      he1_span_consistency_f1: stats.mean(dup1)
    };
  }
  return out;
}

async function he2Disagreements(filter) {
  const [he2, consensusRows] = await Promise.all([
    db.select('he2_responses', {}),
    db.select('he2_consensus', {})
  ]);
  const consensus = new Map(consensusRows.map(c => [c.pair_id, c]));
  const rows = [];
  for (const [pid, slot] of byItem(he2, 'pair_id')) {
    const primary = firstPasses(slot);
    if (primary.length < 2) continue;
    const [aid, arec] = primary[0], [bid, brec] = primary[1];
    const identityDisagree = arec.identity_judgment !== brec.identity_judgment;
    const relationDisagree = !!(arec.relation_judgment && brec.relation_judgment && arec.relation_judgment !== brec.relation_judgment);
    if (filter === 'identity' && !identityDisagree) continue;
    if (filter === 'relation' && !relationDisagree) continue;
    if (filter === 'any' && !identityDisagree && !relationDisagree) continue;
    const pair = data.pairById.get(pid);
    if (!pair) continue;
    rows.push({
      pair_id: pid, label_A: pair.label_A, label_B: pair.label_B,
      a_id: aid, a_identity: arec.identity_judgment, a_relation: arec.relation_judgment, a_direction: arec.direction,
      b_id: bid, b_identity: brec.identity_judgment, b_relation: brec.relation_judgment, b_direction: brec.direction,
      identity_disagree: identityDisagree, relation_disagree: relationDisagree,
      consensus: consensus.get(pid) || null,
      stratum: pair._stratum, source_type: pair._source_type, pipeline_same: pair._pipeline_same
    });
  }
  rows.sort((a, b) => (b.identity_disagree - a.identity_disagree) || (b.relation_disagree - a.relation_disagree) || a.pair_id.localeCompare(b.pair_id));
  return rows;
}

/* ----------------------------------------------------------------- exports */

async function exportHE1() {
  const all = await db.select('he1_responses', { order: 'annotator_id.asc' });
  const rows = [];
  for (const rec of all) {
    const base = {
      annotator_id: rec.annotator_id, paper_id: rec.paper_id, queue_idx: rec.queue_idx,
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
          entry_mode: an.source || 'span', created_at: an.created_at
        }, base));
      }
    }
  }
  return toCSV(rows, ['annotator_id', 'paper_id', 'annotation_id', 'span_start', 'span_end', 'raw_span', 'edited_label',
    'entry_mode', 'response_time_ms', 'created_at', 'queue_idx', 'is_duplicate_pass', 'no_concepts', 'notes', 'completed_at', 'updated_at']);
}

async function exportHE2(includeHidden) {
  const all = await db.select('he2_responses', { order: 'annotator_id.asc' });
  const rows = all.map(rec => {
    const pair = data.pairById.get(rec.pair_id) || {};
    const row = {
      annotator_id: rec.annotator_id, pair_id: rec.pair_id,
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
    return row;
  });
  const cols = ['annotator_id', 'pair_id', 'identity_judgment', 'relation_judgment', 'direction', 'response_time_ms',
    'created_at', 'queue_idx', 'is_duplicate_pass', 'displayed_left', 'notes'];
  if (includeHidden) cols.push('label_A', 'label_B', 'stratum', 'source_type', 'pipeline_relation', 'pipeline_same', 'sense_a', 'sense_b');
  return toCSV(rows, cols);
}

async function exportHE1Gold() {
  const all = await db.select('he1_gold', { order: 'paper_id.asc' });
  const rows = [];
  for (const g of all) {
    for (const s of g.gold || []) {
      rows.push({
        paper_id: g.paper_id,
        span_start: s.start === null || s.start === undefined ? '' : s.start,
        span_end: s.end === null || s.end === undefined ? '' : s.end,
        raw_span: s.text || '', gold_label: s.label || s.text,
        source: s.source || '', adjudicator: g.adjudicator || '', adjudicated_at: g.updated_at || ''
      });
    }
  }
  return toCSV(rows, ['paper_id', 'span_start', 'span_end', 'raw_span', 'gold_label', 'source', 'adjudicator', 'adjudicated_at']);
}

async function exportHE2Consensus() {
  const all = await db.select('he2_consensus', { order: 'pair_id.asc' });
  const rows = all.map(v => {
    const pair = data.pairById.get(v.pair_id) || {};
    return {
      pair_id: v.pair_id, label_A: pair.label_A, label_B: pair.label_B,
      consensus_identity: v.identity || '', consensus_relation: v.relation || '',
      consensus_direction: v.direction || '', adjudicator: v.adjudicator || '',
      note: v.note || '', updated_at: v.updated_at || '',
      stratum: pair._stratum, source_type: pair._source_type, pipeline_same: pair._pipeline_same
    };
  });
  return toCSV(rows, ['pair_id', 'label_A', 'label_B', 'consensus_identity', 'consensus_relation', 'consensus_direction',
    'adjudicator', 'note', 'updated_at', 'stratum', 'source_type', 'pipeline_same']);
}

async function exportBackup() {
  const [annotators, queues, he1, he2, gold, consensus, events] = await Promise.all([
    db.select('annotators', {}), db.select('queue_items', {}),
    db.select('he1_responses', {}), db.select('he2_responses', {}),
    db.select('he1_gold', {}), db.select('he2_consensus', {}),
    db.select('events', { order: 'id.asc' })
  ]);
  return JSON.stringify({
    exported_at: nowISO(),
    protocol_version: PROTOCOL.version,
    study_title: cfg.studyTitle,
    annotators, queue_items: queues,
    he1_responses: he1, he2_responses: he2,
    he1_gold: gold, he2_consensus: consensus, events
  }, null, 2);
}

/* ------------------------------------------------------------------ router */

async function handleAPI(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // ---------- public ----------
  if (p === '/api/protocol' && method === 'GET') return sendJSON(res, 200, PROTOCOL);
  if (p === '/api/config' && method === 'GET') {
    return sendJSON(res, 200, {
      study_title: cfg.studyTitle, protocol_version: PROTOCOL.version,
      task: cfg.task, task_label: TASK_LABEL[cfg.task] || 'Both tasks',
      require_consent: cfg.requireConsent, require_training: cfg.requireTraining,
      enforce_task_order: cfg.enforceTaskOrder, require_access_code: !!cfg.accessCode
    });
  }

  if (p === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const id = (body.annotator_id || '').toString().trim();
    if (cfg.accessCode) {
      const given = (body.access_code || '').toString().trim();
      if (given !== cfg.accessCode.trim()) {
        await logEvent({ type: 'bad_access_code', annotator_id: id.slice(0, 40) });
        return sendJSON(res, 403, { error: 'That access code is not valid. Please check the invitation you were sent.' });
      }
    }
    if (!ID_RE.test(id)) return sendJSON(res, 400, { error: 'Annotator ID must be 2–40 characters: letters, digits, hyphen or underscore.' });
    await ensureAnnotator(id);
    setCookie(res, 'hev_session', sign(id), 60, req);
    await logEvent({ type: 'login', annotator_id: id });
    return sendJSON(res, 200, await meState(id));
  }

  if (p === '/api/logout' && method === 'POST') {
    setCookie(res, 'hev_session', '', 0, req);
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- admin ----------
  if (p === '/api/admin/login' && method === 'POST') {
    const body = await readBody(req);
    if (!cfg.adminToken || (body.token || '') !== cfg.adminToken) return sendJSON(res, 401, { error: 'Invalid admin token' });
    setCookie(res, 'hev_admin', sign('admin'), 7, req);
    return sendJSON(res, 200, { ok: true });
  }

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return sendJSON(res, 401, { error: 'Admin authentication required' });

    if (p === '/api/admin/overview' && method === 'GET') return sendJSON(res, 200, await adminOverview());
    if (p === '/api/admin/agreement' && method === 'GET') return sendJSON(res, 200, await agreementReport());

    if (p === '/api/admin/he1/papers' && method === 'GET') {
      const [he1, gold] = await Promise.all([db.select('he1_responses', {}), db.select('he1_gold', { select: 'paper_id' })]);
      const goldSet = new Set(gold.map(g => g.paper_id));
      const byPaper = byItem(he1, 'paper_id');
      return sendJSON(res, 200, data.papers.map(pp => {
        const slot = byPaper.get(pp.paper_id) || {};
        const primary = firstPasses(slot);
        return {
          paper_id: pp.paper_id, title: pp.title, year: pp.year,
          field: pp._field, journal: pp._journal, density_tercile: pp._density_tercile,
          n_annotators: primary.length,
          annotators: primary.map(([k, r]) => ({ id: k, n: (r.annotations || []).length, done: !!r.completed_at })),
          gold_done: goldSet.has(pp.paper_id)
        };
      }));
    }

    if (p === '/api/admin/he1/reconcile' && method === 'GET') {
      const pid = url.searchParams.get('paper_id');
      const pp = data.paperById.get(pid);
      if (!pp) return sendJSON(res, 404, { error: 'unknown paper' });
      const [resp, goldRows] = await Promise.all([
        db.select('he1_responses', { eq: { paper_id: pid } }),
        db.select('he1_gold', { eq: { paper_id: pid }, limit: 1 })
      ]);
      const per = resp.filter(r => r.completed_at).map(r => ({
        annotator_id: r.annotator_id + (r.is_duplicate ? '__repeat' : ''),
        completed_at: r.completed_at, no_concepts: !!r.no_concepts, notes: r.notes || '',
        annotations: (r.annotations || []).map(a => ({
          start: a.span_start === undefined ? null : a.span_start,
          end: a.span_end === undefined ? null : a.span_end,
          text: a.raw_span, label: a.label, source: a.source || 'span'
        }))
      }));
      return sendJSON(res, 200, {
        paper: { paper_id: pp.paper_id, title: pp.title, year: pp.year, abstract: pp.abstract, field: pp._field, journal: pp._journal },
        pipeline_concepts: (pp._extracted_concepts || '').split('|').map(s => s.trim()).filter(Boolean), // adjudicator-only
        annotators: per,
        gold: goldRows[0] || null
      });
    }

    if (p === '/api/admin/he1/gold' && method === 'POST') {
      const body = await readBody(req);
      const pp = data.paperById.get(body.paper_id);
      if (!pp) return sendJSON(res, 404, { error: 'unknown paper' });
      const gold = (body.gold || []).map(s => {
        const st = Number(s.start), en = Number(s.end);
        const hasSpan = Number.isInteger(st) && Number.isInteger(en) && st >= 0 && en <= pp.abstract.length && en > st;
        return {
          start: hasSpan ? st : null, end: hasSpan ? en : null,
          text: hasSpan ? pp.abstract.slice(st, en) : '',
          label: (s.label || '').toString().trim().slice(0, 300),
          source: s.source || ''
        };
      }).filter(s => s.label || s.text);
      await db.upsert('he1_gold', [{
        paper_id: body.paper_id, gold,
        adjudicator: (body.adjudicator || 'admin').toString().slice(0, 60),
        note: (body.note || '').toString().slice(0, 2000),
        updated_at: nowISO()
      }], { onConflict: 'paper_id' });
      return sendJSON(res, 200, { ok: true, n: gold.length });
    }

    if (p === '/api/admin/he2/disagreements' && method === 'GET') {
      return sendJSON(res, 200, await he2Disagreements(url.searchParams.get('filter') || 'any'));
    }

    if (p === '/api/admin/he2/pair' && method === 'GET') {
      const pid = url.searchParams.get('pair_id');
      const pair = data.pairById.get(pid);
      if (!pair) return sendJSON(res, 404, { error: 'unknown pair' });
      const [resp, consensus] = await Promise.all([
        db.select('he2_responses', { eq: { pair_id: pid } }),
        db.select('he2_consensus', { eq: { pair_id: pid }, limit: 1 })
      ]);
      return sendJSON(res, 200, {
        pair: {
          pair_id: pid, label_A: pair.label_A, context_A: pair.context_A,
          label_B: pair.label_B, context_B: pair.context_B,
          stratum: pair._stratum, source_type: pair._source_type,
          pipeline_relation: pair._pipeline_relation, pipeline_same: pair._pipeline_same
        },
        judgments: resp.filter(r => r.completed_at).map(r => ({
          annotator_id: r.annotator_id + (r.is_duplicate ? '__repeat' : ''),
          identity: r.identity_judgment, relation: r.relation_judgment,
          direction: r.direction, notes: r.notes, response_time_ms: r.response_time_ms
        })),
        consensus: consensus[0] || null
      });
    }

    if (p === '/api/admin/he2/consensus' && method === 'POST') {
      const body = await readBody(req);
      if (!data.pairById.has(body.pair_id)) return sendJSON(res, 404, { error: 'unknown pair' });
      await db.upsert('he2_consensus', [{
        pair_id: body.pair_id,
        identity: IDENTITY_VALUES.includes(body.identity) ? body.identity : null,
        relation: RELATION_VALUES.includes(body.relation) ? body.relation : null,
        direction: ['A', 'B', 'CANNOT'].includes(body.direction) ? body.direction : null,
        adjudicator: (body.adjudicator || 'admin').toString().slice(0, 60),
        note: (body.note || '').toString().slice(0, 2000),
        updated_at: nowISO()
      }], { onConflict: 'pair_id' });
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/admin/export' && method === 'GET') {
      const what = url.searchParams.get('what');
      const map = {
        he1: async () => ['he1_annotations.csv', await exportHE1()],
        he2: async () => ['he2_annotations.csv', await exportHE2(false)],
        he2_full: async () => ['he2_annotations_with_key.csv', await exportHE2(true)],
        he1_gold: async () => ['he1_gold_spans.csv', await exportHE1Gold()],
        he2_consensus: async () => ['he2_consensus.csv', await exportHE2Consensus()],
        backup: async () => [`he_backup_${nowISO().slice(0, 10)}.json`, await exportBackup()]
      };
      if (!map[what]) return sendJSON(res, 400, { error: 'unknown export' });
      const [name, body] = await map[what]();
      return send(res, 200, body, {
        'Content-Type': what === 'backup' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`
      });
    }

    if (p === '/api/admin/reset' && method === 'POST') {
      const body = await readBody(req);
      const id = body.annotator_id;
      if (!ID_RE.test(id || '')) return sendJSON(res, 400, { error: 'bad id' });
      const [h1, h2] = await Promise.all([
        db.select('he1_responses', { eq: { annotator_id: id } }),
        db.select('he2_responses', { eq: { annotator_id: id } })
      ]);
      // archive into the audit log before removing, so nothing is truly lost
      await logEvent({ type: 'reset_archive', annotator_id: id, he1: h1, he2: h2, at: nowISO() });
      await Promise.all([
        db.remove('he1_responses', { eq: { annotator_id: id } }),
        db.remove('he2_responses', { eq: { annotator_id: id } })
      ]);
      if (body.rebuild_queue) {
        await db.remove('queue_items', { eq: { annotator_id: id } });
        await ensureQueues(id);
      }
      return sendJSON(res, 200, { ok: true, archived: { he1: h1.length, he2: h2.length } });
    }

    return sendJSON(res, 404, { error: 'unknown admin endpoint' });
  }

  // ---------- annotator ----------
  const id = currentAnnotator(req);
  if (!id) return sendJSON(res, 401, { error: 'Not signed in' });
  const rec = await getAnnotator(id);
  if (!rec) return sendJSON(res, 401, { error: 'Not signed in' });

  if (p === '/api/me' && method === 'GET') return sendJSON(res, 200, await meState(id));

  if (p === '/api/consent' && method === 'POST') {
    await db.upsert('annotators', [{ annotator_id: id, consent_at: nowISO() }], { onConflict: 'annotator_id' });
    return sendJSON(res, 200, await meState(id));
  }

  if (p === '/api/training/items' && method === 'GET') {
    const training = rec.training || { answers: {} };
    const given = training.answers || {};
    return sendJSON(res, 200, {
      items: trainingItems().map(it => ({
        id: it.id, block: it.block, stem: it.stem, passage: it.passage || null, pair: it.pair || null,
        question: it.question, options: it.options,
        answered: given[it.id] ? { choice: given[it.id].choice, correct: given[it.id].correct, answer: it.answer, explanation: it.explanation } : null
      })),
      completed_at: training.completed_at || null
    });
  }

  if (p === '/api/training/answer' && method === 'POST') {
    const body = await readBody(req);
    const item = TRAINING.items.find(i => i.id === body.id);
    if (!item) return sendJSON(res, 400, { error: 'unknown training item' });
    const correct = body.choice === item.answer;
    const training = rec.training || { answers: {}, completed_at: null, n_correct: 0 };
    training.answers = training.answers || {};
    training.answers[item.id] = { choice: body.choice, correct, at: nowISO() };
    training.n_correct = Object.values(training.answers).filter(a => a.correct).length;
    await db.upsert('annotators', [{ annotator_id: id, training }], { onConflict: 'annotator_id' });
    return sendJSON(res, 200, { correct, answer: item.answer, explanation: item.explanation });
  }

  if (p === '/api/training/complete' && method === 'POST') {
    const training = rec.training || { answers: {} };
    const answers = training.answers || {};
    if (!trainingItems().every(it => !!answers[it.id])) {
      return sendJSON(res, 400, { error: 'Please work through every training example first.' });
    }
    training.completed_at = nowISO();
    await db.upsert('annotators', [{ annotator_id: id, training }], { onConflict: 'annotator_id' });
    return sendJSON(res, 200, await meState(id));
  }

  // this deployment hosts one evaluation; the other one lives on its own site
  if (p.startsWith('/api/he1/') && !HOSTS('he1')) {
    return sendJSON(res, 404, { error: 'This site hosts Evaluation 2 only.' });
  }
  if (p.startsWith('/api/he2/') && !HOSTS('he2')) {
    return sendJSON(res, 404, { error: 'This site hosts Evaluation 1 only.' });
  }

  const st = await meState(id);
  if (!st.tasks_unlocked) {
    if (p.startsWith('/api/he1/') || p.startsWith('/api/he2/')) {
      return sendJSON(res, 403, { error: 'Complete consent and training first.' });
    }
  }

  if (p === '/api/he1/state' && method === 'GET') {
    const [queue, responses] = await Promise.all([
      db.select('queue_items', { eq: { annotator_id: id, task: 'he1' }, select: 'idx', order: 'idx.asc' }),
      db.select('he1_responses', { eq: { annotator_id: id }, select: 'queue_idx,completed_at,annotations' })
    ]);
    const byIdx = new Map(responses.map(r => [Number(r.queue_idx), r]));
    return sendJSON(res, 200, {
      progress: st.he1,
      items: queue.map(q => {
        const r = byIdx.get(Number(q.idx));
        return { idx: Number(q.idx), done: !!(r && r.completed_at), n: r ? (r.annotations || []).length : 0 };
      })
    });
  }
  if (p === '/api/he1/item' && method === 'GET') {
    const it = await he1Item(id, Number(url.searchParams.get('idx')));
    return it ? sendJSON(res, 200, it) : sendJSON(res, 404, { error: 'out of range' });
  }
  if (p === '/api/he1/save' && method === 'POST') {
    try { return sendJSON(res, 200, await he1Save(id, await readBody(req))); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }

  if (p.startsWith('/api/he2/')) {
    if (cfg.enforceTaskOrder && !st.he1.finished) {
      return sendJSON(res, 403, { error: 'Human Evaluation 2 unlocks after Human Evaluation 1 is complete.' });
    }
    if (p === '/api/he2/state' && method === 'GET') {
      const [queue, responses] = await Promise.all([
        db.select('queue_items', { eq: { annotator_id: id, task: 'he2' }, select: 'idx', order: 'idx.asc' }),
        db.select('he2_responses', { eq: { annotator_id: id }, select: 'queue_idx,completed_at' })
      ]);
      const done = new Set(responses.filter(r => r.completed_at).map(r => Number(r.queue_idx)));
      return sendJSON(res, 200, {
        progress: st.he2,
        items: queue.map(q => ({ idx: Number(q.idx), done: done.has(Number(q.idx)) }))
      });
    }
    if (p === '/api/he2/item' && method === 'GET') {
      const it = await he2Item(id, Number(url.searchParams.get('idx')));
      return it ? sendJSON(res, 200, it) : sendJSON(res, 404, { error: 'out of range' });
    }
    if (p === '/api/he2/save' && method === 'POST') {
      try { return sendJSON(res, 200, await he2Save(id, await readBody(req))); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
  }

  return sendJSON(res, 404, { error: 'unknown endpoint' });
}

/** Entry point shared by the local server and the serverless function. */
function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    return handleAPI(req, res, url).catch(err => {
      console.error(err);
      sendJSON(res, 500, { error: 'Server error: ' + err.message });
    });
  }
  return serveStatic(req, res, url.pathname);
}

module.exports = { handleRequest, cfg, PROTOCOL, TRAINING };
