/* Shared helpers for the annotation front-end. */

async function api(path, opts) {
  const res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin'
  }, opts || {}));
  let body = null;
  const txt = await res.text();
  try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = { error: txt }; }
  if (!res.ok) {
    const err = new Error((body && body.error) || ('HTTP ' + res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
const apiGet = p => api(p);
const apiPost = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b || {}) });

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let _toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function topbar(active, me) {
  const links = [
    ['guidelines.html', 'Guidelines'],
    ['training.html', 'Training'],
    ['he1.html', 'Evaluation 1'],
    ['he2.html', 'Evaluation 2']
  ];
  return `
  <div class="topbar">
    <div class="brand">Concept Measurement Study<small>PROTOCOL ${esc(me && me.protocol_version || '')}</small></div>
    <nav>${links.map(([h, t]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${t}</a>`).join('')}</nav>
    <div class="spacer"></div>
    <div class="who">${me ? esc(me.annotator_id) : ''}</div>
    <button class="ghost small" onclick="signOut()">Sign out</button>
  </div>`;
}

async function signOut() {
  await apiPost('/api/logout');
  location.href = '/';
}

/** Loads session state; redirects to the right gate page when prerequisites are missing. */
async function requireSession(opts) {
  opts = opts || {};
  let me;
  try {
    me = await apiGet('/api/me');
  } catch (e) {
    location.href = '/';
    return null;
  }
  if (me.consent_required && !me.consent_at) { location.href = '/'; return null; }
  if (opts.needTraining && me.training_required && !me.training_done) {
    location.href = 'training.html';
    return null;
  }
  return me;
}

/* -------------------------------------------------------- fuzzy highlighting
   HE2 labels are normalized forms and are often not literal substrings of the
   context sentence ("dividends" vs "dividend amounts"). We locate the best
   matching word window so the annotator can see the expression in use. */

/* Light stemmer: plurals, -ing/-ed, doubled final consonant ("programming" -> "program"). */
function stem(w) {
  w = w.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (w.length < 4) return w;
  w = w.replace(/ies$/, 'y').replace(/(ss|sh|ch|x)es$/, '$1').replace(/([^s])s$/, '$1');
  if (/(ing|ed)$/.test(w)) {
    const cut = w.replace(/(ing|ed)$/, '');
    if (cut.length >= 4) w = cut.replace(/([bcdfghjklmnpqrstvwz])\1$/, '$1');
  }
  return w;
}

/* Hyphens and apostrophes are separators, so "performance-related" and
   "performance‐related" (any dash variant) tokenize alike. */
function tokenizeWithOffsets(text) {
  const out = [];
  const re = /[A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(text))) out.push({ w: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/** Returns [start,end] char offsets of the best match of `label` inside `text`, or null. */
function findLabelSpan(text, label) {
  if (!text || !label) return null;
  const lowerT = text.toLowerCase(), lowerL = label.toLowerCase().trim();
  const direct = lowerT.indexOf(lowerL);
  if (direct >= 0) return [direct, direct + lowerL.length];

  const tt = tokenizeWithOffsets(text);
  const lt = tokenizeWithOffsets(label).map(t => stem(t.w)).filter(Boolean);
  if (!lt.length || !tt.length) return null;
  const ts = tt.map(t => stem(t.w));

  let best = null, bestScore = 0, bestLen = Infinity;
  const maxLen = lt.length + 3;
  for (let i = 0; i < tt.length; i++) {
    for (let len = Math.max(1, lt.length - 1); len <= maxLen; len++) {
      if (i + len > tt.length) continue;
      const window = ts.slice(i, i + len);
      let hits = 0;
      for (const s of lt) if (window.includes(s)) hits++;
      if (!hits) continue;
      const score = hits / Math.max(lt.length, len);
      // accept a loose window only when every part of the label is inside it
      const acceptable = score >= 0.6 || (hits === lt.length && len <= maxLen);
      if (!acceptable) continue;
      if (score > bestScore || (score === bestScore && len < bestLen)) {
        bestScore = score; bestLen = len;
        best = [tt[i].start, tt[i + len - 1].end];
      }
    }
  }
  return best;
}

function highlightLabel(text, label) {
  const span = findLabelSpan(text, label);
  if (!span) return esc(text);
  return esc(text.slice(0, span[0])) + '<mark>' + esc(text.slice(span[0], span[1])) + '</mark>' + esc(text.slice(span[1]));
}
