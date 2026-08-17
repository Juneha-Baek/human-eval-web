# Deploying — Vercel + Supabase

Everything in the repo is ready. Three steps need your accounts, because
account creation and key issuance cannot be done for you.

---

## Step 1 — Supabase (the database)

1. Create a project at <https://supabase.com> (region: **Northeast Asia — Seoul**
   or Tokyo, closest to your annotators).
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, run it once.
   That creates seven tables, two analysis views, and enables RLS with no
   policies — so the anon key can read *nothing*. Only this server, holding the
   service role key, can reach the data. That is what keeps the study blind.
3. **Project Settings → API**, copy two values:
   * `Project URL` → `SUPABASE_URL`
   * `service_role` secret → `SUPABASE_SERVICE_ROLE_KEY`

> The service role key bypasses RLS. It belongs in server environment variables
> only — never in the browser, never in the repo, never in a `NEXT_PUBLIC_*`
> style variable.

---

## Step 2 — run it locally once (optional but recommended)

```bash
cd C:/Users/joonha/Desktop/human_eval_web
cp .env.example .env        # then fill in the four values
node server.js              # http://localhost:8080
```

`.env` is gitignored. If Supabase credentials are missing the server refuses to
start rather than silently falling back to something non-persistent.

To run the test suite without touching the database:

```bash
DB_MOCK=1 node server.js
```

---

## Step 3 — GitHub (a **private** repo)

`human_eval/HE2_key.csv` holds strata, sense ids and pipeline predictions. If
annotators could read it the study would be unblinded, so keep the repo private.

```bash
gh auth login
gh repo create human-eval-web --private --source=. --remote=origin --push
```

---

## Step 4 — Vercel: **two projects from the same repo**

The two tasks run as separate sites over one shared database. Import the same
repository twice; the only difference is the `TASK` variable.

For **each** project:

1. <https://vercel.com> → sign in with GitHub → **Add New… → Project** → import
   `human-eval-web`.
2. Project name: `concept-coverage` for the first, `concept-identity` for the
   second.
3. Framework preset: **Other**. Leave build/install commands empty —
   `vercel.json` already declares everything (static files from `public/`, one
   serverless function at `api/index.js`, all `/api/*` routed to it).
4. **Environment Variables** — five, identical across both projects except the
   first line:

   ```
   TASK                         he1          ← "he2" in the second project
   SUPABASE_URL                 https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY    (from Supabase)
   ADMIN_TOKEN                  d8jC_pZqAxCNBElBCNu9TfDNDK-41Ci8
   ACCESS_CODE                  concept-3a634db4
   ```

   (The last two were generated for you; change them if you like. `ACCESS_CODE`
   is what annotators type on the first screen; `ADMIN_TOKEN` is your
   coordinator password.)
5. **Deploy.**

You end up with two URLs, e.g.
`https://concept-coverage.vercel.app` and `https://concept-identity.vercel.app`.

What the split does:

* each site shows only its own task, its own definition on the guidelines page,
  and only the three training examples that belong to it
* the `/api/*` route of the other task returns 404 on the wrong site
* the same annotator ID works on both sites — consent, IDs and the coordinator
  console are shared, because both read one Supabase project
* the two can be run independently, in either order, by the same or different
  people

The coordinator console (`/admin.html`) is available on both sites and always
shows the whole study, both tasks.

Free tier is sufficient: the function only reads and writes small rows, and
cold starts are a few hundred milliseconds. Later pushes redeploy both projects.

> Want one combined site instead? Deploy once with `TASK=both`.

---

## Step 5 — check before inviting anyone

1. Open **each** URL, enter the access code and a throwaway ID such as `TEST99`.
2. Training → one item → confirm it saves, reload, confirm it resumes.
3. In Supabase → **Table Editor → he1_responses**, confirm the row is there.
4. Open `/admin.html`, sign in with `ADMIN_TOKEN`, confirm `TEST99` appears.
5. **Progress** tab → `reset` next to `TEST99`. That archives their work into
   the `events` table and clears the responses.

---

## Step 6 — invite annotators

Give each person their own ID plus the shared link and code:

> Task 1 — Concept Coverage: https://concept-coverage.vercel.app
> Task 2 — Concept Identity: https://concept-identity.vercel.app
> Access code: concept-3a634db4
> Your annotator ID: **A01**
>
> Use exactly this ID on both sites — it is how your work is saved and resumed.
> Each site has its own short training. You can stop and return at any time.

Assign IDs yourself (`A01`, `A02`, …). Two annotators is the design: both get
all 72 abstracts and all 360 pairs, each in a different randomized order.

---

## While collection runs

**Backups.** Supabase has its own backups, but keep your own copy too:

```bash
curl -H "X-Admin-Token: $ADMIN_TOKEN" \
     "https://concept-coverage.vercel.app/api/admin/export?what=backup" \
     -o he_backup_$(date +%F).json
```

**Watch reliability** in the admin console as data accumulates. If
same/different κ comes in low early, re-read the protocol with the annotators
*before* they finish 360 pairs.

**Query directly** in the Supabase SQL editor — two views are set up:

```sql
-- concepts recorded per paper, dragged or typed
select paper_id, annotator_id, concept_label, entry_mode
from he1_concepts order by paper_id;

-- where the two coders disagree on identity
select * from he2_agreement where not identity_match;

-- median seconds per pair, per coder (a QC check for rushing)
select annotator_id,
       percentile_cont(0.5) within group (order by response_time_ms/1000.0) as median_sec
from he2_responses where completed_at is not null group by 1;
```

---

## Updating the app

`git push` → Vercel redeploys. The database is untouched by deploys.

Do **not** edit `protocol/definitions.json` once collection has started — those
two definitions are the measurement. If they must change, bump `version` and
treat earlier data as a separate round.
