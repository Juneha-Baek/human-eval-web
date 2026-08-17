'use strict';

/**
 * Storage layer — Supabase Postgres over PostgREST, using fetch only.
 *
 * The service_role key bypasses RLS, and every table has RLS enabled with no
 * policies, so the database is reachable *only* through this server. The key
 * must never reach the browser.
 *
 * A memory adapter (DB_MOCK=1) implements the same small query surface so the
 * test suite can run without a database. It is never used unless explicitly
 * requested.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_MOCK = process.env.DB_MOCK === '1';

if (!USE_MOCK && (!SUPABASE_URL || !SERVICE_KEY)) {
  throw new Error(
    'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. ' +
    'Set them in .env (local) or in the hosting dashboard, or set DB_MOCK=1 for tests.'
  );
}

/* ------------------------------------------------------------ query helpers */

function buildQuery(opts = {}) {
  const parts = [`select=${encodeURIComponent(opts.select || '*')}`];
  for (const [col, val] of Object.entries(opts.eq || {})) {
    parts.push(`${encodeURIComponent(col)}=eq.${encodeURIComponent(val)}`);
  }
  for (const [col, vals] of Object.entries(opts.in || {})) {
    parts.push(`${encodeURIComponent(col)}=in.(${vals.map(v => encodeURIComponent(v)).join(',')})`);
  }
  if (opts.order) parts.push(`order=${encodeURIComponent(opts.order)}`);
  if (opts.limit) parts.push(`limit=${opts.limit}`);
  return parts.join('&');
}

/* --------------------------------------------------------- supabase adapter */

async function rest(method, table, { query, body, headers } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;
  const res = await fetch(url, {
    method,
    headers: Object.assign({
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json'
    }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${table} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  if (!text) return [];
  try { return JSON.parse(text); } catch (e) { return []; }
}

const PAGE = 1000;

const supabaseAdapter = {
  /**
   * PostgREST caps a response at the deployment's max-rows setting, so a plain
   * GET can silently truncate. Exports read whole tables (778 HE2 rows for two
   * coders, more for three), and a truncated export would corrupt the analysis
   * without any error — so page explicitly through Range headers.
   */
  async select(table, opts) {
    const query = buildQuery(opts);
    if (opts.limit && opts.limit <= PAGE) return rest('GET', table, { query });
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const rows = await rest('GET', table, {
        query,
        headers: { 'Range-Unit': 'items', Range: `${offset}-${offset + PAGE - 1}` }
      });
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  },
  async upsert(table, rows, opts = {}) {
    if (!rows.length) return [];
    const query = opts.onConflict ? `on_conflict=${encodeURIComponent(opts.onConflict)}` : '';
    return rest('POST', table, {
      query,
      body: rows,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
    });
  },
  async insert(table, rows) {
    if (!rows.length) return [];
    return rest('POST', table, { body: rows, headers: { Prefer: 'return=minimal' } });
  },
  async remove(table, opts) {
    return rest('DELETE', table, { query: buildQuery(opts), headers: { Prefer: 'return=minimal' } });
  }
};

/* ----------------------------------------------------------- memory adapter */

const mem = new Map();                       // table -> array of rows
const PK = {                                 // conflict keys, mirroring the schema
  annotators: ['annotator_id'],
  queue_items: ['annotator_id', 'task', 'idx'],
  he1_responses: ['annotator_id', 'queue_idx'],
  he2_responses: ['annotator_id', 'queue_idx'],
  he1_gold: ['paper_id'],
  he2_consensus: ['pair_id'],
  events: null
};

function table(t) {
  if (!mem.has(t)) mem.set(t, []);
  return mem.get(t);
}
function matches(row, opts) {
  for (const [col, val] of Object.entries(opts.eq || {})) {
    if (String(row[col]) !== String(val)) return false;
  }
  for (const [col, vals] of Object.entries(opts.in || {})) {
    if (!vals.map(String).includes(String(row[col]))) return false;
  }
  return true;
}

const memoryAdapter = {
  async select(t, opts = {}) {
    let rows = table(t).filter(r => matches(r, opts)).map(r => Object.assign({}, r));
    if (opts.order) {
      const [col, dir] = opts.order.split('.');
      rows.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return rows;
  },
  async upsert(t, rows, opts = {}) {
    const keys = (opts.onConflict ? opts.onConflict.split(',') : PK[t]) || [];
    for (const row of rows) {
      const i = table(t).findIndex(r => keys.every(k => String(r[k]) === String(row[k])));
      if (i >= 0) table(t)[i] = Object.assign({}, table(t)[i], row);
      else table(t).push(Object.assign({}, row));
    }
    return [];
  },
  async insert(t, rows) {
    for (const row of rows) table(t).push(Object.assign({}, row));
    return [];
  },
  async remove(t, opts = {}) {
    mem.set(t, table(t).filter(r => !matches(r, opts)));
    return [];
  }
};

const adapter = USE_MOCK ? memoryAdapter : supabaseAdapter;

module.exports = {
  select: (t, o) => adapter.select(t, o || {}),
  upsert: (t, rows, o) => adapter.upsert(t, rows, o || {}),
  insert: (t, rows) => adapter.insert(t, rows),
  remove: (t, o) => adapter.remove(t, o || {}),
  isMock: USE_MOCK,
  _resetMock: () => mem.clear()
};
