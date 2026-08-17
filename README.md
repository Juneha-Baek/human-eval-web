# Human Evaluation — annotation web app

Annotation platform for the two human validations of the scientific concept
measurement framework:

| Task | Question | Role |
|---|---|---|
| **HE1 — Concept Coverage** | Does the measurement represent the reusable scientific concepts present in a paper? | supporting content-validity check |
| **HE2 — Concept Identity** | Should two scientific expressions be treated as one concept identity? | central human validation |

Material already in `human_eval/`: 72 papers (HE1) and 360 pairs (HE2).

---

## Run it

```bash
cp .env.example .env      # Supabase URL + service role key, admin token, access code
node server.js            # http://localhost:8080
```

No dependencies — Node 18+ stdlib only. Nothing to install.
State lives in Supabase Postgres; the app writes nothing to disk, so it runs
unchanged as a serverless function.

* annotator: <http://localhost:8080/>
* coordinator: <http://localhost:8080/admin.html>

Run the test suite against an in-memory store instead of the database with
`DB_MOCK=1 node server.js`.

---

## Deployment

**Vercel (web) + Supabase (database)** — see `DEPLOY.md` for the full walkthrough.

The two tasks deploy as **two sites from this one repo**, distinguished by the
`TASK` environment variable (`he1` / `he2`), sharing a single database. Each
site serves only its own task, its own definition, and its own three training
examples; the other task's API returns 404. Annotator IDs and the coordinator
console are shared. `TASK=both` gives the combined single-site version.

`vercel.json` serves `public/` statically and routes every `/api/*` request to
the single function in `api/index.js`, which is the same handler the local
server uses. `supabase/schema.sql` creates the tables, the analysis views, and
the RLS lockdown.

Self-hosting works too: the `Dockerfile` runs `server.js` on Fly, a VPS, or
anywhere else. No volume is needed — the container is stateless.

Environment variables (all server-side):

| | |
|---|---|
| `SUPABASE_URL` | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** — bypasses RLS, never expose to a browser |
| `ADMIN_TOKEN` | coordinator password for `/admin.html` |
| `ACCESS_CODE` | shared code annotators type on the first screen (optional) |
| `TASK` | `he1`, `he2`, or `both` — which evaluation this deployment hosts |
| `SESSION_SECRET` | optional; derived from the service key if unset |

### Where the responses go
The browser posts each judgment to `/api/he1/save` and `/api/he2/save`; the
server writes it to Supabase; the coordinator pulls CSVs from the admin console
or queries the views in SQL. No Google Form, spreadsheet or third-party
collector is involved — and none could serve this study, because HE1 records
character offsets from a drag selection and HE2 needs per-annotator
randomization, blinding, duplicate items, response timing and resume.

### Backups
```bash
curl -H "X-Admin-Token: $ADMIN_TOKEN" \
     "https://<host>/api/admin/export?what=backup" -o he_backup_$(date +%F).json
```
Supabase keeps its own backups; take this one too, daily, while collection runs.

---

## How it works

### Annotator flow
`Sign in (ID + access code) → consent → guidelines → training with feedback →
the task (72 abstracts, or 360 pairs)`

The two tasks are independent sites and can be run in either order, or by
different people. Setting `enforceTaskOrder` true on a `TASK=both` deployment
restores the original gate, where HE2 opens only after HE1 is finished.

### Blinding
Annotators never receive, in any API response:
pipeline extractions, EQ/BN/PW/RE/UN predictions, merge decisions,
direct/closure provenance, risk or similarity scores, sense ids, strata.
Those fields live behind `/api/admin/*`, which requires the admin token.

Randomization per annotator (deterministic from the ID, so resuming never
reshuffles): item order, HE2 left/right side assignment, and injected duplicate
items (HE1 ≈6%, HE2 ≈8%, never closer than 40 items apart) for intra-rater
consistency.

### Frozen measurement definitions
`protocol/definitions.json` holds the two definitions the whole study rests on —
**Scientific Concept** and **Same Concept** — plus the boundary rules, the
independent-referent test and the collapse test. Every screen renders from this
file, so the guidelines, the training feedback and the in-task help can never
drift apart. Editing it after collection has begun invalidates the gold set:
bump `version` and start a new round instead.

### Recorded per judgment
HE1: `annotator_id, paper_id, annotation_id, span_start, span_end, raw_span,
edited_label, response_time_ms, created_at` (+ duplicate flag, notes).
HE2: `annotator_id, pair_id, identity_judgment, relation_judgment, direction,
response_time_ms, created_at` (+ which side each expression was shown on, so
direction answers map back to canonical A/B).

### Coordinator console
Progress per annotator · reliability (percent agreement, Cohen's κ,
Krippendorff's α, span-overlap F1, intra-rater consistency) · HE1 reconciliation
(both annotators' highlights over the abstract, adjudicate the consensus gold
set, drag to add a missed span) · HE2 adjudication (disagreement filters,
consensus per pair) · CSV exports.

The pipeline output is available on the HE1 reconciliation screen only behind a
collapsed "reveal" control, so the human gold set can be fixed before anyone
sees what the system produced.

---

## Layout

```
config.json                study title, duplicate rates, gating
protocol/definitions.json  FROZEN measurement definitions (v1.0-frozen)
protocol/training.json     6 training examples with explanations
human_eval/*.csv           study material (+ the hidden keys)
supabase/schema.sql        tables, RLS lockdown, analysis views
lib/app.js                 the whole request handler
lib/db.js                  Supabase access (fetch only) + test adapter
lib/                       csv, queues, statistics, env
public/                    annotator UI + coordinator console
api/index.js               Vercel entry -> lib/app.js
server.js                  local / self-hosted entry -> lib/app.js
```

## Analysis performed outside this app

* **HE1 coverage** = share of consensus human concepts represented in the locked
  measurement, judged by semantic correspondence — not exact string match
  (`foreign divestment` ≡ `divestment of international operations`).
* **HE2 primary** = same/different accuracy and EQ precision / recall / F1
  against the consensus gold, broken down by `source_type`: direct (local
  judgment), closure-implied (overmerge), unmerged plausible (fragmentation).
* **Jangle recovery** = P(system SAME | human SAME, surface forms differ).
* **Jingle preservation** = P(system DIFFERENT | human DIFFERENT, surface
  similarity high).

Build the jangle/jingle subsets *after* the human gold is fixed — annotators are
never told which pairs are candidates.
