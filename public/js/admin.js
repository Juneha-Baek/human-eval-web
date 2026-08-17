/* Coordinator console: progress, reliability, HE1 reconciliation, HE2 adjudication, exports. */

const root = () => document.getElementById('root');

function pct(x) { return x === null || x === undefined ? '—' : (100 * x).toFixed(1) + '%'; }
function num(x, d) { return x === null || x === undefined ? '—' : Number(x).toFixed(d === undefined ? 3 : d); }
function shortDate(s) { return s ? s.slice(0, 16).replace('T', ' ') : '—'; }

function setActive() {
  const h = location.hash.split('/')[0] || '#overview';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === h));
}

/* --------------------------------------------------------------- overview */
async function viewOverview() {
  const d = await apiGet('/api/admin/overview');
  const rows = d.annotators.map(a => `
    <tr>
      <td><strong>${esc(a.annotator_id)}</strong><div class="small muted">last seen ${shortDate(a.last_seen)}</div></td>
      <td>${a.consent_at ? '<span class="pill ok">yes</span>' : '<span class="pill warn">no</span>'}</td>
      <td>${a.training_completed_at ? `<span class="pill ok">${esc(a.training_score)}</span>` : '<span class="pill grey">pending</span>'}</td>
      <td>
        <div class="progress-line"><span class="mono">${a.he1_done}/${a.he1_total}</span>
        <div class="bar" style="width:110px"><i style="width:${a.he1_total ? 100 * a.he1_done / a.he1_total : 0}%"></i></div></div>
        <div class="small muted">${a.he1_spans} spans · ${a.he1_minutes} min</div>
      </td>
      <td>
        <div class="progress-line"><span class="mono">${a.he2_done}/${a.he2_total}</span>
        <div class="bar" style="width:110px"><i style="width:${a.he2_total ? 100 * a.he2_done / a.he2_total : 0}%"></i></div></div>
        <div class="small muted">${a.he2_minutes} min</div>
      </td>
      <td><button class="small danger" data-reset="${esc(a.annotator_id)}">reset</button></td>
    </tr>`).join('');

  root().innerHTML = `
    <h1>${esc(d.study_title)}</h1>
    <p class="lede small">Protocol ${esc(d.protocol_version)} · ${d.n_papers} papers in HE1 · ${d.n_pairs} pairs in HE2</p>
    <div class="panel">
      <table>
        <thead><tr><th>Annotator</th><th>Consent</th><th>Training</th><th>HE1 — coverage</th><th>HE2 — identity</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">No annotators have signed in yet.</td></tr>'}</tbody>
      </table>
    </div>
    <p class="small muted">Duplicated items for intra-rater consistency are injected automatically into each annotator's queue and are counted in the totals above.</p>`;

  root().querySelectorAll('[data-reset]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.reset;
      if (!confirm(`Archive all annotations by ${id}? Their work is moved to data/backup and they start over.`)) return;
      await apiPost('/api/admin/reset', { annotator_id: id, rebuild_queue: false });
      viewOverview();
    };
  });
}

/* ------------------------------------------------------------ reliability */
async function viewReliability() {
  const r = await apiGet('/api/admin/agreement');
  const intra = Object.entries(r.intra).map(([id, v]) => `
    <tr><td>${esc(id)}</td>
      <td>${v.he1_repeated_papers}</td><td>${pct(v.he1_span_consistency_f1)}</td>
      <td>${v.he2_repeated_items}</td><td>${pct(v.he2_identity_consistency)}</td><td>${num(v.he2_identity_kappa)}</td></tr>`).join('');

  root().innerHTML = `
    <h1>Reliability</h1>
    <p class="lede small">Computed over completed items only. Inter-rater statistics use each annotator's first pass on an item.</p>

    <div class="panel">
      <h2 style="margin-top:0">HE2 — concept identity</h2>
      <table>
        <tbody>
          <tr><td>Pairs judged by two annotators</td><td class="mono">${r.he2.pairs_with_two_annotators}</td></tr>
          <tr><td>Identity — percent agreement (3-way)</td><td class="mono">${pct(r.he2.identity_percent_agreement)}</td></tr>
          <tr><td>Identity — Cohen's κ</td><td class="mono">${num(r.he2.identity_kappa)}</td></tr>
          <tr><td>Identity — Krippendorff's α</td><td class="mono">${num(r.he2.identity_alpha)}</td></tr>
          <tr><td><strong>Same vs. different — percent agreement</strong></td><td class="mono"><strong>${pct(r.he2.same_vs_different_percent_agreement)}</strong></td></tr>
          <tr><td><strong>Same vs. different — Cohen's κ</strong></td><td class="mono"><strong>${num(r.he2.same_vs_different_kappa)}</strong></td></tr>
          <tr><td>Relation subtype — percent agreement <span class="small muted">(n=${r.he2.n_relation_comparable})</span></td><td class="mono">${pct(r.he2.relation_percent_agreement)}</td></tr>
          <tr><td>Relation subtype — Cohen's κ</td><td class="mono">${num(r.he2.relation_kappa)}</td></tr>
          <tr><td>“Cannot determine” rate</td><td class="mono">${pct(r.he2.cannot_determine_rate)}</td></tr>
        </tbody>
      </table>
      <p class="small muted" style="margin:10px 0 0">Primary validity is the same/different row; the relation subtype is secondary.</p>
    </div>

    <div class="panel">
      <h2 style="margin-top:0">HE1 — concept coverage</h2>
      <table><tbody>
        <tr><td>Papers annotated by two annotators</td><td class="mono">${r.he1.papers_with_two_annotators}</td></tr>
        <tr><td>Mean span-overlap F1 between annotators</td><td class="mono">${pct(r.he1.mean_span_overlap_f1)}</td></tr>
        <tr><td>Mean concepts per abstract</td><td class="mono">${num(r.he1.mean_concepts_per_paper, 2)}</td></tr>
        <tr><td>Completed paper annotations</td><td class="mono">${r.he1.completed_paper_annotations}</td></tr>
      </tbody></table>
      <p class="small muted" style="margin:10px 0 0">Span overlap counts two spans as matching when their character ranges overlap at all — a boundary-tolerant measure, matching the fact that coverage is scored semantically rather than by exact string.</p>
    </div>

    <div class="panel">
      <h2 style="margin-top:0">Intra-rater consistency (repeated items)</h2>
      <table>
        <thead><tr><th>Annotator</th><th>HE1 repeats</th><th>Span F1</th><th>HE2 repeats</th><th>Identity agreement</th><th>κ</th></tr></thead>
        <tbody>${intra || '<tr><td colspan="6" class="muted">No repeated items completed yet.</td></tr>'}</tbody>
      </table>
    </div>`;
}

/* ------------------------------------------------------- HE1 reconciliation */
async function viewHE1List() {
  const rows = await apiGet('/api/admin/he1/papers');
  const body = rows.map(p => `
    <tr>
      <td><a href="#he1/${encodeURIComponent(p.paper_id)}">${esc(p.title.slice(0, 90))}${p.title.length > 90 ? '…' : ''}</a>
        <div class="small muted">${esc(p.journal || '')} ${p.year ? '· ' + esc(p.year) : ''}</div></td>
      <td>${esc(p.field)}</td>
      <td>${p.annotators.map(a => `<span class="pill ${a.done ? 'ok' : 'grey'}">${esc(a.id)}: ${a.n}</span>`).join(' ') || '<span class="small muted">—</span>'}</td>
      <td>${p.gold_done ? '<span class="pill ok">gold set</span>' : '<span class="pill grey">open</span>'}</td>
    </tr>`).join('');
  root().innerHTML = `
    <h1>HE1 reconciliation</h1>
    <p class="lede small">Adjudicate the two annotators' highlights into the consensus human set used for the coverage metric.</p>
    <div class="panel"><table>
      <thead><tr><th>Paper</th><th>Field</th><th>Annotators (spans)</th><th>Gold</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
}

function segmentAbstract(text, layers) {
  // layers: [{key, spans:[{start,end}]}]
  const pts = new Set([0, text.length]);
  layers.forEach(l => l.spans.forEach(s => { pts.add(s.start); pts.add(s.end); }));
  const cuts = [...pts].filter(p => p >= 0 && p <= text.length).sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1];
    if (b <= a) continue;
    const owners = layers.filter(l => l.spans.some(s => s.start <= a && s.end >= b)).map(l => l.key);
    let cls = '';
    if (owners.length > 1) cls = 'hl-ab';
    else if (owners.length === 1) cls = owners[0] === 0 ? 'hl-a' : 'hl-b';
    html += `<span data-start="${a}" class="${cls}">${esc(text.slice(a, b))}</span>`;
  }
  return html;
}

async function viewHE1Detail(pid) {
  const d = await apiGet('/api/admin/he1/reconcile?paper_id=' + encodeURIComponent(pid));
  const text = d.paper.abstract;
  const anns = d.annotators;
  const layers = anns.map((a, i) => ({ key: i, spans: a.annotations }));

  // candidate pool: union of spans, identical ranges merged
  const map = new Map();
  anns.forEach(a => a.annotations.forEach(s => {
    const k = s.start + ':' + s.end;
    if (!map.has(k)) map.set(k, { start: s.start, end: s.end, text: s.text, label: s.label, sources: [] });
    map.get(k).sources.push(a.annotator_id);
  }));
  let candidates = [...map.values()].sort((a, b) => a.start - b.start);
  const gold = d.gold ? d.gold.gold : null;
  const inGold = s => !gold ? s.sources.length > 1 : gold.some(g => g.start === s.start && g.end === s.end);
  candidates.forEach(c => { c.selected = inGold(c); });
  if (gold) {
    for (const g of gold) {
      if (!candidates.some(c => c.start === g.start && c.end === g.end)) {
        candidates.push({ start: g.start, end: g.end, text: g.text, label: g.label, sources: ['adjudicator'], selected: true });
      }
    }
    candidates.sort((a, b) => a.start - b.start);
  }

  function renderCandidates() {
    document.getElementById('cands').innerHTML = candidates.map((c, i) => `
      <li>
        <input type="checkbox" data-i="${i}" ${c.selected ? 'checked' : ''} style="width:auto;margin-top:5px">
        <span class="txt"><input type="text" data-lbl="${i}" value="${esc(c.label || c.text)}"></span>
        <span class="small muted" style="min-width:90px;text-align:right">${c.sources.map(s => esc(s)).join(', ')}</span>
      </li>`).join('');
    document.querySelectorAll('#cands input[type=checkbox]').forEach(cb => {
      cb.onchange = () => { candidates[Number(cb.dataset.i)].selected = cb.checked; };
    });
    document.querySelectorAll('#cands input[data-lbl]').forEach(inp => {
      inp.oninput = () => { candidates[Number(inp.dataset.lbl)].label = inp.value; };
    });
  }

  root().innerHTML = `
    <div class="row"><a href="#he1" class="small">← all papers</a></div>
    <h1 style="font-size:20px">${esc(d.paper.title)}</h1>
    <p class="lede small">${esc(d.paper.journal || '')} · ${esc(d.paper.year || '')} · ${esc(d.paper.field || '')}</p>

    <div class="legend panel tight">
      ${anns.map((a, i) => `<span><i class="${i === 0 ? 'hl-a' : 'hl-b'}"></i> ${esc(a.annotator_id)} (${a.annotations.length})</span>`).join('')}
      <span><i class="hl-ab"></i> both</span>
      <span class="right small muted">Drag on the abstract to add a span the annotators missed.</span>
    </div>

    <div class="two-col">
      <div class="panel">
        <div class="abstract" id="recAbs">${segmentAbstract(text, layers)}</div>
      </div>
      <div class="sticky-side">
        <div class="panel">
          <div class="row" style="margin-bottom:8px"><strong style="flex:1">Consensus gold set</strong>
            <span class="pill grey" id="goldN"></span></div>
          <ul class="concept-list" id="cands"></ul>
          <label class="field" style="margin-top:10px"><span>Adjudicator</span>
            <input type="text" id="adj" value="${esc(d.gold ? d.gold.adjudicator : '')}" placeholder="your name or ID"></label>
          <label class="field"><span>Note</span><textarea id="gnote">${esc(d.gold ? d.gold.note : '')}</textarea></label>
          <button class="primary" id="saveGold" style="width:100%">Save gold set</button>
          <p class="small muted" style="margin-top:8px">Default selection: spans both annotators marked.</p>
        </div>
        <details class="panel tight">
          <summary class="small muted" style="cursor:pointer">Reveal pipeline output (biasing — open only after the gold set is fixed)</summary>
          <div style="margin-top:8px">${d.pipeline_concepts.map(c => `<span class="example-good">${esc(c)}</span>`).join('') || '<span class="small muted">none</span>'}</div>
        </details>
      </div>
    </div>`;

  renderCandidates();

  // drag to add an adjudicator span
  document.getElementById('recAbs').addEventListener('mouseup', () => setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const cont = document.getElementById('recAbs');
    if (!cont.contains(range.commonAncestorContainer)) return;
    const off = (node, o) => {
      let el = node.nodeType === 3 ? node.parentElement : node;
      let extra = node.nodeType === 3 ? o : 0;
      while (el && !el.dataset.start && el.id !== 'recAbs') el = el.parentElement;
      if (!el || el.id === 'recAbs') return null;
      return Number(el.dataset.start) + extra;
    };
    let s = off(range.startContainer, range.startOffset);
    let e = off(range.endContainer, range.endOffset);
    sel.removeAllRanges();
    if (s === null || e === null) return;
    if (s > e) [s, e] = [e, s];
    const raw = text.slice(s, e).trim();
    if (raw.length < 2) return;
    const start = s + (text.slice(s, e).length - text.slice(s, e).replace(/^\s+/, '').length);
    candidates.push({ start, end: start + raw.length, text: raw, label: raw, sources: ['adjudicator'], selected: true });
    candidates.sort((a, b) => a.start - b.start);
    renderCandidates();
  }, 0));

  document.getElementById('saveGold').onclick = async () => {
    const goldSpans = candidates.filter(c => c.selected).map(c => ({ start: c.start, end: c.end, label: c.label, source: c.sources.join('+') }));
    await apiPost('/api/admin/he1/gold', {
      paper_id: pid, gold: goldSpans,
      adjudicator: document.getElementById('adj').value,
      note: document.getElementById('gnote').value
    });
    toast(`Gold set saved (${goldSpans.length} concepts)`);
  };
}

/* --------------------------------------------------------- HE2 adjudication */
async function viewHE2List() {
  const filter = (location.hash.split('?')[1] || '').replace('filter=', '') || 'any';
  const rows = await apiGet('/api/admin/he2/disagreements?filter=' + encodeURIComponent(filter));
  const body = rows.map(r => `
    <tr>
      <td><a href="#he2/${encodeURIComponent(r.pair_id)}" class="mono">${esc(r.pair_id)}</a></td>
      <td style="font-family:var(--serif)">${esc(r.label_A)} <span class="muted">↔</span> ${esc(r.label_B)}</td>
      <td>${esc(r.a_id)}: <strong>${esc(r.a_identity)}</strong>${r.a_relation ? ' / ' + esc(r.a_relation) : ''}</td>
      <td>${esc(r.b_id)}: <strong>${esc(r.b_identity)}</strong>${r.b_relation ? ' / ' + esc(r.b_relation) : ''}</td>
      <td>${r.identity_disagree ? '<span class="pill warn">identity</span>' : ''}${r.relation_disagree ? ' <span class="pill">relation</span>' : ''}</td>
      <td>${r.consensus ? `<span class="pill ok">${esc(r.consensus.identity || '')}${r.consensus.relation ? '/' + esc(r.consensus.relation) : ''}</span>` : '<span class="pill grey">open</span>'}</td>
    </tr>`).join('');
  root().innerHTML = `
    <h1>HE2 adjudication</h1>
    <p class="lede small">Pairs judged by two annotators. Resolve disagreements into the consensus human gold.</p>
    <div class="row" style="margin-bottom:12px">
      ${['any', 'identity', 'relation', 'all'].map(f => `<a class="btn small ${filter === f ? 'primary' : ''}" href="#he2?filter=${f}">${f === 'any' ? 'any disagreement' : f === 'all' ? 'all double-coded pairs' : f + ' disagreement'}</a>`).join('')}
    </div>
    <div class="panel"><table>
      <thead><tr><th>Pair</th><th>Expressions</th><th>Annotator 1</th><th>Annotator 2</th><th>Conflict</th><th>Consensus</th></tr></thead>
      <tbody>${body || '<tr><td colspan="6" class="muted">Nothing to show yet.</td></tr>'}</tbody></table></div>`;
}

async function viewHE2Detail(pid) {
  const d = await apiGet('/api/admin/he2/pair?pair_id=' + encodeURIComponent(pid));
  const p = d.pair;
  const c = d.consensus || {};
  const rel = ['BN', 'PW', 'RE', 'UN', 'CANNOT'];
  root().innerHTML = `
    <div class="row"><a href="#he2" class="small">← all pairs</a></div>
    <h1 style="font-size:20px" class="mono">${esc(p.pair_id)}</h1>
    <div class="pair-grid" style="margin-bottom:18px">
      <div class="side">
        <div class="side-tag">Concept A</div>
        <div class="label">${esc(p.label_A)}</div>
        <div class="ctx">${highlightLabel(p.context_A, p.label_A)}</div>
      </div>
      <div class="side">
        <div class="side-tag">Concept B</div>
        <div class="label">${esc(p.label_B)}</div>
        <div class="ctx">${highlightLabel(p.context_B, p.label_B)}</div>
      </div>
    </div>

    <div class="two-col">
      <div class="panel">
        <h3 style="margin-top:0">Judgments</h3>
        <table><thead><tr><th>Annotator</th><th>Identity</th><th>Relation</th><th>Direction</th><th>Time</th><th>Note</th></tr></thead>
        <tbody>${d.judgments.map(j => `<tr>
          <td>${esc(j.annotator_id)}</td><td><strong>${esc(j.identity || '')}</strong></td>
          <td>${esc(j.relation || '')}</td><td>${esc(j.direction || '')}</td>
          <td class="small muted">${Math.round((j.response_time_ms || 0) / 1000)}s</td>
          <td class="small">${esc(j.notes || '')}</td></tr>`).join('')}</tbody></table>

        <details style="margin-top:14px">
          <summary class="small muted" style="cursor:pointer">Reveal hidden pair metadata (blinded from annotators)</summary>
          <table style="margin-top:8px"><tbody>
            <tr><td>Stratum</td><td class="mono">${esc(p.stratum)}</td></tr>
            <tr><td>Provenance</td><td class="mono">${esc(p.source_type)}</td></tr>
            <tr><td>Pipeline relation</td><td class="mono">${esc(p.pipeline_relation || '—')}</td></tr>
            <tr><td>Same final identity in system</td><td class="mono">${esc(p.pipeline_same)}</td></tr>
          </tbody></table>
        </details>
      </div>

      <div class="sticky-side panel">
        <h3 style="margin-top:0">Consensus</h3>
        <label class="field"><span>Identity</span>
          <select id="cid">
            <option value="">—</option>
            ${['SAME', 'DIFFERENT', 'CANNOT'].map(v => `<option value="${v}" ${c.identity === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select></label>
        <label class="field"><span>Relation (if different)</span>
          <select id="crel"><option value="">—</option>
            ${rel.map(v => `<option value="${v}" ${c.relation === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select></label>
        <label class="field"><span>Direction (broader / whole)</span>
          <select id="cdir"><option value="">—</option>
            ${['A', 'B', 'CANNOT'].map(v => `<option value="${v}" ${c.direction === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select></label>
        <label class="field"><span>Adjudicator</span><input type="text" id="cadj" value="${esc(c.adjudicator || '')}"></label>
        <label class="field"><span>Note</span><textarea id="cnote">${esc(c.note || '')}</textarea></label>
        <button class="primary" id="csave" style="width:100%">Save consensus</button>
      </div>
    </div>`;

  document.getElementById('csave').onclick = async () => {
    await apiPost('/api/admin/he2/consensus', {
      pair_id: pid,
      identity: document.getElementById('cid').value,
      relation: document.getElementById('crel').value,
      direction: document.getElementById('cdir').value,
      adjudicator: document.getElementById('cadj').value,
      note: document.getElementById('cnote').value
    });
    toast('Consensus saved');
  };
}

/* ----------------------------------------------------------------- export */
function viewExport() {
  const items = [
    ['he1', 'HE1 annotations', 'One row per highlighted span: annotator, paper, offsets, raw span, edited label, timing.'],
    ['he1_gold', 'HE1 consensus gold spans', 'Adjudicated human concept set per paper — the set the coverage metric is computed against.'],
    ['he2', 'HE2 judgments (blinded)', 'One row per judgment: identity, relation, direction, timing. No pipeline metadata.'],
    ['he2_full', 'HE2 judgments + hidden key', 'The same rows joined to stratum, provenance, pipeline relation and sense ids. Analysis only.'],
    ['he2_consensus', 'HE2 consensus gold', 'Adjudicated identity/relation per pair.'],
    ['backup', 'Full raw backup (JSON)', 'Everything the server holds: annotators, queues, every saved judgment, gold sets, event log. Pull this daily while collection runs.']
  ];
  root().innerHTML = `
    <h1>Export</h1>
    <p class="lede small">CSV, UTF-8 with BOM. Analysis scripts should join on <span class="mono">paper_id</span> / <span class="mono">pair_id</span>.</p>
    <div class="panel">${items.map(([k, t, d]) => `
      <div class="row" style="padding:12px 0;border-bottom:1px solid var(--line)">
        <div style="flex:1"><strong>${t}</strong><div class="small muted">${d}</div></div>
        <a class="btn" href="/api/admin/export?what=${k}">Download</a>
      </div>`).join('')}
    </div>
    <div class="panel tight">
      <h3 style="margin-top:0">Derived measures (computed outside this app)</h3>
      <ul class="small muted" style="margin:0;padding-left:18px">
        <li><strong>HE1 coverage</strong> = share of consensus human concepts represented in the locked measurement, judged by semantic correspondence rather than exact string match.</li>
        <li><strong>HE2 primary</strong> = same/different accuracy, EQ precision / recall / F1 against the consensus human gold.</li>
        <li><strong>Jangle recovery</strong> = P(system SAME | human SAME, surface forms differ) — build the subset after the gold is fixed.</li>
        <li><strong>Jingle preservation</strong> = P(system DIFFERENT | human DIFFERENT, surface similarity high).</li>
        <li>Break all HE2 measures down by <span class="mono">source_type</span>: direct, closure-implied (overmerge), unmerged plausible (fragmentation).</li>
      </ul>
    </div>`;
}

/* ------------------------------------------------------------------ router */
async function route() {
  setActive();
  const h = location.hash || '#overview';
  const [head, arg] = h.slice(1).split('/');
  try {
    if (head.startsWith('he1')) return await (arg ? viewHE1Detail(decodeURIComponent(arg)) : viewHE1List());
    if (head.startsWith('he2')) return await (arg ? viewHE2Detail(decodeURIComponent(arg)) : viewHE2List());
    if (head.startsWith('reliability')) return await viewReliability();
    if (head.startsWith('export')) return viewExport();
    return await viewOverview();
  } catch (e) {
    if (e.status === 401) return showLogin();
    root().innerHTML = `<div class="panel"><p class="err">${esc(e.message)}</p></div>`;
  }
}

function showLogin() {
  document.getElementById('login').style.display = '';
  root().innerHTML = '';
}

document.getElementById('lgo').onclick = async () => {
  try {
    await apiPost('/api/admin/login', { token: document.getElementById('tok').value });
    document.getElementById('login').style.display = 'none';
    route();
  } catch (e) { document.getElementById('lerr').textContent = e.message; }
};
document.getElementById('tok').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('lgo').click(); });

window.addEventListener('hashchange', route);
route();
