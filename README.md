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
node server.js          # or: npm start
```

* annotator: <http://localhost:8080/>
* coordinator: <http://localhost:8080/admin.html>

No dependencies — Node 18+ stdlib only. Nothing to install.

**Before collecting data:** set `adminToken` in `config.json` (or the
`ADMIN_TOKEN` environment variable).

---

## Deployment

The server reads `PORT`, `HOST`, `ADMIN_TOKEN` and `DATA_DIR` from the
environment, so the same code runs everywhere. All state is plain JSON under
`DATA_DIR` (default `./data`) — **that directory is the entire dataset**; back it
up and never let a host wipe it between deploys.

### 1. Same network (simplest, no accounts)
Run the server on one machine, let annotators reach it over the LAN.

```bash
ADMIN_TOKEN='...' node server.js
# Windows firewall: allow inbound TCP 8080 once
```
Annotators open `http://<your-lan-ip>:8080/`. Suitable when everyone is on the
same campus network / VPN.

### 2. Public URL from your own machine (Cloudflare Tunnel)
Fastest way to give remote annotators a link without renting a server.

```bash
node server.js                       # terminal 1
cloudflared tunnel --url http://localhost:8080   # terminal 2 -> prints an https URL
```
The tunnel gives HTTPS; the session cookie is marked `Secure` automatically.
Your machine must stay awake for the duration. (`ngrok http 8080` works the same
way.)

### 3. Hosted, always on (Render / Railway / Fly / any VPS)
Push this folder to a git repo and deploy with Docker (`Dockerfile` included).

Required settings:
* env `ADMIN_TOKEN` — the coordinator password
* env `DATA_DIR=/data` and a **persistent disk mounted at `/data`**
  (on Render: “Disks”; Railway: volume; Fly: `fly volumes create`)
* start command `node server.js`; the platform's `PORT` is picked up

Without a persistent disk the platform's filesystem is ephemeral and every
redeploy or restart discards the annotations.

On a bare VPS, run it under systemd behind nginx (`proxy_pass`
`http://127.0.0.1:8080`, plus `proxy_set_header X-Forwarded-Proto $scheme`) with
a Let's Encrypt certificate.

### Not Vercel (as written)
Vercel and other serverless hosts give each request an ephemeral filesystem, so
`data/` would be discarded between requests — annotators could not resume, and
saved judgments would vanish. Running here requires replacing `lib/store.js`
with a database (Neon/Supabase Postgres, Upstash KV) and making the storage
calls async. Any host with a persistent disk avoids that work entirely.

### Where the responses go
Nowhere else. The browser posts each judgment to `/api/he1/save` and
`/api/he2/save`; the server writes it under `DATA_DIR`; the coordinator pulls
CSVs from the admin console. No Google Form, spreadsheet or third-party
collector is involved — and none could serve this study, because HE1 records
character offsets from a drag selection and HE2 needs per-annotator
randomization, blinding, duplicate items, response timing and resume.

### Backups
```bash
tar czf he-backup-$(date +%F).tgz data/     # or copy the folder
```
Or, from anywhere, pull a single-file snapshot of everything the server holds:
```bash
curl -H "X-Admin-Token: $ADMIN_TOKEN" \
     "https://<host>/api/admin/export?what=backup" -o he_backup_$(date +%F).json
```
Do this daily while collection runs (the admin console has the same download
under *Export*). The CSV exports are derived data — `data/` is the source of
truth.

---

## How it works

### Annotator flow
`Sign in (ID) → consent → guidelines → 10 training examples with feedback →
HE1 (all 72 abstracts) → HE2 (360 pairs)`

HE2 unlocks only after HE1 is finished (`enforceTaskOrder`), so pairwise
identity judgments cannot teach annotators pipeline-style concept boundaries
before the coverage task.

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
config.json              port, admin token, duplicate rates, gating
protocol/definitions.json  FROZEN measurement definitions (v1.0-frozen)
protocol/training.json     10 training examples with explanations
human_eval/*.csv         study material (+ the hidden keys)
lib/                     csv, storage, queues, statistics
public/                  annotator UI + coordinator console
data/                    all collected annotations (created at runtime)
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
