/* Human Evaluation 2 — pairwise concept identity and semantic relation. */

let ME = null, P = null, STATE = null, ITEM = null;
let idx = 0;
let answer = { identity: null, relation: null, direction: null };
let lastFlush = Date.now();
let dirty = false;
let saveTimer = null;

const CHOICE_HINTS = {
  SAME: 'One concept identity',
  DIFFERENT: 'Distinct referents',
  CANNOT: 'Not enough information'
};

function renderChoices() {
  document.getElementById('choices').innerHTML = P.he2.primary_options.map((o, i) => `
    <div class="choice ${answer.identity === o.value ? 'sel' : ''}" data-v="${o.value}">
      ${esc(o.label)}
      <small>${esc(CHOICE_HINTS[o.value] || '')} · press ${i + 1}</small>
    </div>`).join('');
  document.querySelectorAll('#choices .choice').forEach(c => {
    c.onclick = () => setIdentity(c.dataset.v);
  });
}

function renderRelation() {
  const show = answer.identity === 'DIFFERENT';
  document.getElementById('q2wrap').style.display = show ? '' : 'none';
  if (!show) return;
  document.getElementById('relOpts').innerHTML = P.he2.secondary_options.map(o => `
    <label class="${answer.relation === o.value ? 'sel' : ''}">
      <input type="radio" name="rel" value="${o.value}" ${answer.relation === o.value ? 'checked' : ''}>
      <span>${esc(o.label)}</span>
    </label>`).join('');
  document.querySelectorAll('#relOpts input').forEach(r => {
    r.onchange = () => {
      answer.relation = r.value;
      if (answer.relation !== 'BN' && answer.relation !== 'PW') answer.direction = null;
      dirty = true;
      renderRelation();
      scheduleSave();
    };
  });

  const dirShow = answer.relation === 'BN' || answer.relation === 'PW';
  document.getElementById('q3wrap').style.display = dirShow ? '' : 'none';
  if (dirShow) {
    document.getElementById('q3').textContent = answer.relation === 'BN'
      ? 'Which expression is the broader one?'
      : 'Which expression is the whole (the other being its part)?';
    const labels = {
      LEFT: ITEM.left.label,
      RIGHT: ITEM.right.label,
      CANNOT: 'Cannot determine'
    };
    document.getElementById('dirOpts').innerHTML = ['LEFT', 'RIGHT', 'CANNOT'].map(v => `
      <label class="${answer.direction === v ? 'sel' : ''}">
        <input type="radio" name="dir" value="${v}" ${answer.direction === v ? 'checked' : ''}>
        <span style="font-family:${v === 'CANNOT' ? 'inherit' : 'var(--serif)'};font-size:${v === 'CANNOT' ? '14px' : '15.5px'}">${esc(labels[v])}</span>
      </label>`).join('');
    document.querySelectorAll('#dirOpts input').forEach(r => {
      r.onchange = () => { answer.direction = r.value; dirty = true; renderRelation(); scheduleSave(); };
    });
  }
}

function setIdentity(v) {
  answer.identity = v;
  if (v !== 'DIFFERENT') { answer.relation = null; answer.direction = null; }
  dirty = true;
  renderChoices();
  renderRelation();
  scheduleSave();
}

function showContext(ctxId, noteId, side) {
  const found = !!findLabelSpan(side.context, side.label);
  document.getElementById(ctxId).innerHTML = highlightLabel(side.context, side.label);
  document.getElementById(noteId).style.display = found ? 'none' : '';
}

function renderProgress() {
  const p = STATE.progress;
  document.getElementById('ptxt').textContent = `${p.done} / ${p.total} complete`;
  document.getElementById('pbar').style.width = (100 * p.done / p.total) + '%';
  document.getElementById('pairCount').textContent = `Pair ${idx + 1} of ${p.total}`;
  document.getElementById('prev').disabled = idx === 0;
  document.getElementById('next').textContent = (idx + 1 >= p.total) ? 'Save & Finish' : 'Save & Next';
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush(false), 600);
}

async function flush(complete) {
  clearTimeout(saveTimer);
  if (!ITEM) return null;
  if (!dirty && !complete) return null;
  const now = Date.now();
  const elapsed = now - lastFlush;
  lastFlush = now;
  let res;
  try {
    res = await apiPost('/api/he2/save', {
      idx: ITEM.idx,
      identity: answer.identity,
      relation: answer.relation,
      direction: answer.direction,
      notes: document.getElementById('notes').value,
      elapsed_ms: elapsed,
      complete: !!complete
    });
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
  renderProgress();
  return res;
}

async function load(newIdx) {
  idx = Math.max(0, Math.min(STATE.progress.total - 1, newIdx));
  ITEM = await apiGet('/api/he2/item?idx=' + idx);
  const s = ITEM.saved || {};
  answer = {
    identity: s.identity_judgment || null,
    relation: s.relation_judgment || null,
    direction: s.direction_displayed || null
  };
  document.getElementById('labL').textContent = ITEM.left.label;
  document.getElementById('labR').textContent = ITEM.right.label;
  showContext('ctxL', 'noteL', ITEM.left);
  showContext('ctxR', 'noteR', ITEM.right);
  document.getElementById('notes').value = s.notes || '';
  lastFlush = Date.now();
  dirty = false;
  renderChoices();
  renderRelation();
  renderProgress();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  history.replaceState(null, '', '?idx=' + idx);
}

async function nextItem() {
  if (!answer.identity) { toast('Choose one of the three answers first.'); return; }
  if (answer.identity === 'DIFFERENT' && !answer.relation) { toast('Choose how the two are related.'); return; }
  const saved = await flush(true);
  if (!saved) return;   // save failed; stay on this item so nothing is lost
  if (idx + 1 >= STATE.progress.total) {
    if (STATE.progress.done >= STATE.progress.total) { location.href = 'done.html?task=he2'; return; }
    const firstOpen = STATE.items.find(i => !i.done);
    toast('Jumping to the first item still open.');
    load(firstOpen ? firstOpen.idx : idx);
    return;
  }
  load(idx + 1);
}

(async function () {
  ME = await requireSession({ needTraining: true });
  if (!ME) return;
  document.getElementById('bar').innerHTML = topbar('he2.html', ME);
  P = await apiGet('/api/protocol');

  document.getElementById('q1').textContent = P.he2.primary_question;
  document.getElementById('q2').textContent = P.he2.secondary_question;
  document.getElementById('collapseTest').textContent = P.same_concept.decisive_test.text;
  document.getElementById('help').innerHTML = `
    <div class="definition" style="margin:0">
      <div class="term">${esc(P.same_concept.term)}</div>
      <div class="small">${esc(P.same_concept.definition)}</div>
      <div class="small" style="margin-top:8px"><strong>${esc(P.same_concept.emphasis)}</strong></div>
      <div class="small" style="margin-top:8px"><strong>${esc(P.same_concept.decisive_test.name)}:</strong>
        ${esc(P.same_concept.decisive_test.text)}<br>
        ${esc(P.same_concept.decisive_test.no)} &nbsp;·&nbsp; ${esc(P.same_concept.decisive_test.yes)}</div>
    </div>
    <p class="small muted" style="margin:8px 0 0"><a href="guidelines.html" target="_blank">Full guidelines →</a></p>`;
  document.getElementById('helpBtn').onclick = () => {
    const h = document.getElementById('help');
    h.style.display = h.style.display === 'none' ? '' : 'none';
  };

  try {
    STATE = await apiGet('/api/he2/state');
  } catch (e) {
    alert(e.message);
    location.href = '/';
    return;
  }

  const q = new URLSearchParams(location.search).get('idx');
  await load(q !== null ? Number(q) : STATE.progress.next_idx);

  document.getElementById('next').onclick = nextItem;
  document.getElementById('prev').onclick = async () => { await flush(false); load(idx - 1); };
  document.getElementById('notes').oninput = () => { dirty = true; scheduleSave(); };

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.key === '1') setIdentity('SAME');
    else if (e.key === '2') setIdentity('DIFFERENT');
    else if (e.key === '3') setIdentity('CANNOT');
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); nextItem(); }
  });
  setInterval(() => { if (dirty) flush(false); }, 15000);
})();
