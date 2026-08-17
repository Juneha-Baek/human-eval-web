/* Human Evaluation 1 — span highlighting on title + abstract. */

let ME = null;
let ITEM = null;          // {idx,total,paper,saved}
let ANN = [];             // [{annotation_id,start,end,raw,label}]
let STATE = null;         // queue state
let idx = 0;
let lastFlush = Date.now();
let saveTimer = null;
let dirty = false;

const WORD_CHAR = /[A-Za-z0-9À-ɏ'’\-]/;
const TRIM_LEAD = /^[\s.,;:()\[\]"'“”…\-–—/]+/;
const TRIM_TAIL = /[\s.,;:()\[\]"'“”…\-–—/]+$/;

/* --------------------------------------------------------------- rendering */
function renderAbstract() {
  const text = ITEM.paper.abstract || '';
  const marks = ANN.slice().sort((a, b) => a.start - b.start);
  let html = '';
  let cursor = 0;
  for (const m of marks) {
    if (m.start > cursor) {
      html += `<span data-start="${cursor}">${esc(text.slice(cursor, m.start))}</span>`;
    }
    html += `<mark data-start="${m.start}" data-id="${esc(m.annotation_id)}" title="Click to remove">${esc(text.slice(m.start, m.end))}</mark>`;
    cursor = m.end;
  }
  if (cursor < text.length) html += `<span data-start="${cursor}">${esc(text.slice(cursor))}</span>`;
  const el = document.getElementById('abs');
  el.innerHTML = html;
  el.querySelectorAll('mark').forEach(mk => {
    mk.onclick = () => removeAnn(mk.dataset.id);
  });
}

function renderList() {
  const ul = document.getElementById('list');
  const sorted = ANN.slice().sort((a, b) => a.start - b.start);
  document.getElementById('nSel').textContent = ANN.length;
  document.getElementById('emptyHint').style.display = ANN.length ? 'none' : '';
  ul.innerHTML = sorted.map((a, i) => `
    <li data-id="${esc(a.annotation_id)}">
      <span class="idx">${i + 1}</span>
      <span class="txt"><span class="lbl">${esc(a.label)}</span></span>
      <button class="ghost small" data-act="edit" title="Edit the text of this concept">edit</button>
      <button class="ghost small" data-act="del" title="Remove">×</button>
    </li>`).join('');
  ul.querySelectorAll('button').forEach(b => {
    const li = b.closest('li');
    const id = li.dataset.id;
    b.onclick = () => b.dataset.act === 'del' ? removeAnn(id) : startEdit(li, id);
  });
  ul.querySelectorAll('li').forEach(li => {
    li.onmouseenter = () => flashMark(li.dataset.id, true);
    li.onmouseleave = () => flashMark(li.dataset.id, false);
  });
}

function flashMark(id, on) {
  const mk = document.querySelector(`#abs mark[data-id="${CSS.escape(id)}"]`);
  if (mk) mk.style.background = on ? 'var(--mark-strong)' : '';
}

function startEdit(li, id) {
  const a = ANN.find(x => x.annotation_id === id);
  if (!a) return;
  const holder = li.querySelector('.txt');
  holder.innerHTML = `<input type="text" value="${esc(a.label)}">`;
  const input = holder.querySelector('input');
  input.focus();
  input.select();
  const commit = () => {
    a.label = input.value.trim() || a.raw;
    markDirty();
    renderList();
  };
  input.onblur = commit;
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { renderList(); }
  };
}

function renderMap() {
  const el = document.getElementById('map');
  if (!STATE) return;
  el.innerHTML = STATE.items.map(it => `
    <a href="#" data-idx="${it.idx}" title="Item ${it.idx + 1}${it.done ? ' · done' : ''}"
       style="display:block;height:12px;border-radius:2px;text-decoration:none;
       background:${it.idx === idx ? 'var(--accent)' : (it.done ? 'var(--a-color)' : 'var(--line)')}"></a>`).join('');
  el.querySelectorAll('a').forEach(a => {
    a.onclick = async e => { e.preventDefault(); await flush(false); load(Number(a.dataset.idx)); };
  });
}

function renderProgress() {
  const p = STATE.progress;
  document.getElementById('ptxt').textContent = `${p.done} / ${p.total} complete`;
  document.getElementById('pbar').style.width = (100 * p.done / p.total) + '%';
  document.getElementById('paperCount').textContent = `Paper ${idx + 1} of ${p.total}`;
  document.getElementById('prev').disabled = idx === 0;
  document.getElementById('next').textContent = (idx + 1 >= p.total) ? 'Save & Finish' : 'Save & Next';
}

/* ------------------------------------------------------------- selection */
function offsetOf(node, offsetInNode) {
  const container = document.getElementById('abs');
  if (node === container) {
    let total = 0;
    for (let i = 0; i < offsetInNode && i < container.childNodes.length; i++) {
      total += (container.childNodes[i].textContent || '').length;
    }
    const first = container.childNodes[0];
    const base = first && first.dataset ? Number(first.dataset.start) : 0;
    return base + total;
  }
  let el = node.nodeType === 3 ? node.parentElement : node;
  let extra = 0;
  if (node.nodeType === 3) extra = offsetInNode;
  else {
    for (let i = 0; i < offsetInNode && i < node.childNodes.length; i++) extra += (node.childNodes[i].textContent || '').length;
  }
  while (el && !el.dataset.start && el.id !== 'abs') el = el.parentElement;
  if (!el || el.id === 'abs') return null;
  return Number(el.dataset.start) + extra;
}

function snap(text, start, end) {
  while (start > 0 && WORD_CHAR.test(text[start - 1]) && WORD_CHAR.test(text[start])) start--;
  while (end < text.length && WORD_CHAR.test(text[end]) && WORD_CHAR.test(text[end - 1])) end++;
  let raw = text.slice(start, end);
  const lead = raw.match(TRIM_LEAD);
  if (lead) { start += lead[0].length; raw = text.slice(start, end); }
  const tail = raw.match(TRIM_TAIL);
  if (tail) { end -= tail[0].length; }
  return [start, end];
}

function onSelect() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const container = document.getElementById('abs');
  if (!container.contains(range.commonAncestorContainer)) return;

  let s = offsetOf(range.startContainer, range.startOffset);
  let e = offsetOf(range.endContainer, range.endOffset);
  if (s === null || e === null) return;
  if (s > e) [s, e] = [e, s];
  const text = ITEM.paper.abstract;
  [s, e] = snap(text, s, e);
  sel.removeAllRanges();
  if (e - s < 2) return;

  if (ANN.some(a => Math.min(a.end, e) > Math.max(a.start, s))) {
    toast('That overlaps a concept you already selected.');
    return;
  }
  const raw = text.slice(s, e);
  ANN.push({
    annotation_id: 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    start: s, end: e, raw, label: raw, created_at: new Date().toISOString()
  });
  document.getElementById('noConcepts').checked = false;
  markDirty();
  renderAbstract();
  renderList();
}

function removeAnn(id) {
  ANN = ANN.filter(a => a.annotation_id !== id);
  markDirty();
  renderAbstract();
  renderList();
}

/* ---------------------------------------------------------------- saving */
function markDirty() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush(false), 700);
}

async function flush(complete) {
  clearTimeout(saveTimer);
  if (!ITEM) return null;
  if (!dirty && !complete) return null;
  const now = Date.now();
  const elapsed = now - lastFlush;
  lastFlush = now;
  const payload = {
    idx: ITEM.idx,
    annotations: ANN.map(a => ({
      annotation_id: a.annotation_id, start: a.start, end: a.end, label: a.label, created_at: a.created_at
    })),
    no_concepts: document.getElementById('noConcepts').checked,
    notes: document.getElementById('notes').value,
    elapsed_ms: elapsed,
    complete: !!complete
  };
  let res;
  try {
    res = await apiPost('/api/he1/save', payload);
  } catch (err) {
    lastFlush = now - elapsed;   // keep the time; retry on the next autosave tick
    dirty = true;
    toast('Could not save — will retry. Do not close this tab.');
    return null;
  }
  dirty = false;
  STATE.progress = res.progress;
  const it = STATE.items.find(i => i.idx === ITEM.idx);
  if (it && complete) it.done = true;
  if (it) it.n = ANN.length;
  renderProgress();
  renderMap();
  return res;
}

/* --------------------------------------------------------------- loading */
async function load(newIdx) {
  idx = Math.max(0, Math.min(STATE.progress.total - 1, newIdx));
  ITEM = await apiGet('/api/he1/item?idx=' + idx);
  ANN = (ITEM.saved && ITEM.saved.annotations || []).map(a => ({
    annotation_id: a.annotation_id, start: a.span_start, end: a.span_end,
    raw: a.raw_span, label: a.label, created_at: a.created_at
  }));
  document.getElementById('title').textContent = ITEM.paper.title;
  document.getElementById('meta').textContent = ITEM.paper.year ? `Published ${ITEM.paper.year}` : '';
  document.getElementById('noConcepts').checked = !!(ITEM.saved && ITEM.saved.no_concepts);
  document.getElementById('notes').value = (ITEM.saved && ITEM.saved.notes) || '';
  document.getElementById('dupFlag').innerHTML =
    (ITEM.saved && ITEM.saved.completed_at) ? '<span class="pill ok">Saved</span>' : '';
  lastFlush = Date.now();
  dirty = false;
  renderAbstract();
  renderList();
  renderProgress();
  renderMap();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  history.replaceState(null, '', '?idx=' + idx);
}

async function nextItem() {
  if (!ANN.length && !document.getElementById('noConcepts').checked) {
    toast('Select at least one concept, or tick “no reusable scientific concepts”.');
    return;
  }
  const saved = await flush(true);
  if (!saved) return;   // save failed; stay on this item so nothing is lost
  if (idx + 1 >= STATE.progress.total) {
    if (STATE.progress.done >= STATE.progress.total) {
      location.href = 'done.html?task=he1';
      return;
    }
    const firstOpen = STATE.items.find(i => !i.done);
    toast('Jumping to the first item still open.');
    load(firstOpen ? firstOpen.idx : idx);
    return;
  }
  load(idx + 1);
}

/* ------------------------------------------------------------------ init */
(async function () {
  ME = await requireSession({ needTraining: true });
  if (!ME) return;
  document.getElementById('bar').innerHTML = topbar('he1.html', ME);

  const P = await apiGet('/api/protocol');
  document.getElementById('help').innerHTML = `
    <div class="definition" style="margin:0">
      <div class="term">${esc(P.scientific_concept.term)}</div>
      <div class="small">${esc(P.scientific_concept.definition)}</div>
      <div class="small" style="margin-top:8px"><strong>${esc(P.scientific_concept.operational_test.name)}:</strong>
        ${esc(P.scientific_concept.operational_test.text)}</div>
      <div class="small" style="margin-top:8px">${esc(P.scientific_concept.method_rule)}</div>
    </div>
    <div style="margin-top:10px">
      ${P.scientific_concept.include_examples.map(x => `<span class="example-good">${esc(x)}</span>`).join('')}
      ${P.scientific_concept.exclude_examples.map(x => `<span class="example-bad">${esc(x)}</span>`).join('')}
    </div>
    <p class="small muted" style="margin:8px 0 0"><a href="guidelines.html" target="_blank">Full guidelines →</a></p>`;
  document.getElementById('helpBtn').onclick = () => {
    const h = document.getElementById('help');
    h.style.display = h.style.display === 'none' ? '' : 'none';
  };

  try {
    STATE = await apiGet('/api/he1/state');
  } catch (e) {
    alert(e.message);
    location.href = '/';
    return;
  }

  const q = new URLSearchParams(location.search).get('idx');
  await load(q !== null ? Number(q) : STATE.progress.next_idx);

  document.getElementById('abs').addEventListener('mouseup', () => setTimeout(onSelect, 0));
  document.getElementById('abs').addEventListener('keyup', e => { if (e.shiftKey) setTimeout(onSelect, 0); });
  document.getElementById('noConcepts').onchange = () => {
    if (document.getElementById('noConcepts').checked && ANN.length) {
      if (!confirm('Remove the concepts you already selected for this abstract?')) {
        document.getElementById('noConcepts').checked = false;
        return;
      }
      ANN = [];
      renderAbstract();
      renderList();
    }
    markDirty();
  };
  document.getElementById('notes').oninput = markDirty;
  document.getElementById('next').onclick = nextItem;
  document.getElementById('prev').onclick = async () => { await flush(false); load(idx - 1); };

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); nextItem(); }
  });
  window.addEventListener('beforeunload', e => {
    if (dirty) { navigator.sendBeacon && flush(false); }
  });
  setInterval(() => { if (dirty) flush(false); }, 15000);
})();
