# Deploying to Render

Everything in the repo is ready. What is left needs your account, because
account creation and password entry cannot be done for you.

---

## Step 1 — put the code on GitHub (a **private** repo)

The repo contains `human_eval/HE2_key.csv` — strata, sense ids and pipeline
predictions. If annotators could read it, the study would be unblinded. Keep the
repository private.

```bash
cd C:/Users/joonha/Desktop/human_eval_web

gh auth login                 # you do this once, in your own terminal
gh repo create human-eval-web --private --source=. --remote=origin --push
```

The first commit is already made locally, so `--push` uploads it as is.

(If you prefer the web UI: create an empty private repo, then
`git remote add origin <url> && git branch -M main && git push -u origin main`.)

---

## Step 2 — create the Render service

1. Sign in at <https://render.com> with your GitHub account.
2. **New +** → **Blueprint** → select the `human-eval-web` repo.
   Render reads `render.yaml` and proposes a web service with a 1 GB disk
   mounted at `/var/data`.
3. It will ask for the two values marked `sync: false`. Paste:

   ```
   ADMIN_TOKEN   d8jC_pZqAxCNBElBCNu9TfDNDK-41Ci8
   ACCESS_CODE   concept-3a634db4
   ```

   (Generated for you; replace them with anything you prefer. `ACCESS_CODE` is
   what annotators type on the first screen, `ADMIN_TOKEN` is your coordinator
   password.)
4. **Apply** / **Create**. The first deploy takes a couple of minutes.

You get `https://human-eval-web-XXXX.onrender.com`.

### Cost, stated plainly
The blueprint requests `plan: starter` (about **$7/month**, plus ~$0.25/month for
the 1 GB disk). This is not optional on Render: free instances have **no
persistent disk** and sleep when idle, so annotations would be lost on every
restart. If you would rather not pay, the alternatives are a Cloudflare tunnel
from your own machine (free, but the machine must stay awake) or moving storage
to a hosted Postgres so a free instance becomes safe.

---

## Step 3 — check it before inviting anyone

1. Open the URL, enter the access code and a throwaway ID such as `TEST99`.
2. Walk through training → one HE1 abstract → confirm it saves.
3. Open `/admin.html`, sign in with `ADMIN_TOKEN`, confirm `TEST99` appears.
4. Delete the test data: **Progress** tab → `reset` next to `TEST99`
   (this archives rather than deletes; the archive lives in `data/backup`).

---

## Step 4 — invite annotators

Send each person their own ID, plus the shared link and access code:

> Link: https://human-eval-web-XXXX.onrender.com
> Access code: concept-3a634db4
> Your annotator ID: **A01**
>
> Please use exactly this ID — it is how your work is saved and resumed.
> The study has two tasks and takes several sessions; you can stop and return
> at any time.

Assign IDs yourself (`A01`, `A02`, …). Two annotators per task is the design:
both get all 72 abstracts and all 360 pairs, in a different order each.

---

## While collection runs

Pull a backup daily — a hosted disk is not a backup:

```bash
curl -H "X-Admin-Token: d8jC_pZqAxCNBElBCNu9TfDNDK-41Ci8" \
     "https://human-eval-web-XXXX.onrender.com/api/admin/export?what=backup" \
     -o he_backup_$(date +%F).json
```

Watch **Reliability** in the admin console as data accumulates. If
same/different κ comes in low early, that is a signal to re-read the protocol
with the annotators — *before* they finish 360 pairs, not after.

---

## Updating the app after deploy

`git push` → Render redeploys automatically. The disk at `/var/data` survives
deploys, so annotations are not affected.

Do **not** edit `protocol/definitions.json` once collection has started — the
two definitions are the measurement. If they must change, bump `version` and
treat the earlier data as a separate round.
