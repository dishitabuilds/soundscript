# Deploying SoundScript

Two pieces ship together from this repo via [render.yaml](render.yaml): the
**API** (a persistent Node service) and the **web** frontend (a static Vite
build). This runbook covers the steps that can only happen in your accounts —
the code is already deploy-ready.

## 0. Prerequisites

- A GitHub account, a Render account, and a Supabase project (the same one you
  linked locally, or a fresh production project).
- An ElevenLabs API key and/or an OpenAI API key.

## 1. Put the repo on GitHub

There is no git remote yet, so Render has nothing to connect to. Create an
empty repo on GitHub, then:

```bash
git remote add origin https://github.com/<you>/soundscript.git
git push -u origin main
```

## 2. Prepare the production database

Point the Supabase CLI at the project you'll deploy against and push the schema
(all migrations, including the newest feature batch):

```bash
npx supabase link --project-ref <your-prod-ref>
npx supabase db push        # tables, RLS, RPCs, storage buckets
npx supabase config push    # auth settings, incl. anonymous sign-in
```

Confirm in the Supabase dashboard that **anonymous sign-ins are enabled**
(Authentication → Providers) — the guest flow depends on it.

## 3. Create the Render Blueprint

In Render: **New → Blueprint**, pick the GitHub repo. Render reads
`render.yaml` and proposes two services: `soundscript-api` and
`soundscript-web`. It will prompt for every `sync: false` variable.

### `soundscript-api` env vars

| Key                         | Value                                                     |
| --------------------------- | --------------------------------------------------------- |
| `SUPABASE_URL`              | your project URL                                          |
| `SUPABASE_ANON_KEY`         | anon key                                                  |
| `ELEVEN_API_KEY`            | ElevenLabs key (optional if using OpenAI)                 |
| `OPENAI_API_KEY`            | OpenAI key (optional; also the ElevenLabs-quota fallback) |
| `SUPABASE_SERVICE_ROLE_KEY` | only if you want the podcast feed                         |
| `ALLOWED_ORIGINS`           | **fill in step 4**                                        |

### `soundscript-web` env vars

| Key                      | Value                                                    |
| ------------------------ | -------------------------------------------------------- |
| `VITE_BACKEND_URL`       | the API URL, e.g. `https://soundscript-api.onrender.com` |
| `VITE_SUPABASE_URL`      | your project URL                                         |
| `VITE_SUPABASE_ANON_KEY` | anon key                                                 |

## 4. Close the CORS loop

The two services reference each other, so one value can only be filled once both
have URLs:

1. After the first deploy, copy the **web** service URL
   (e.g. `https://soundscript-web.onrender.com`).
2. Set the API's `ALLOWED_ORIGINS` to exactly that origin (comma-separate if you
   have more than one), and redeploy the API.

Without this, the browser gets a CORS error on every request.

## 5. Verify

- `https://soundscript-api.onrender.com/api/health` → `{"ok":true, ...}`. Check
  which providers/features it reports as enabled.
- Open the web URL, upload a small document, confirm it narrates end to end.

## Notes & gotchas

- **Free-plan cold starts.** Render's free web service sleeps after inactivity;
  the first request wakes it (~30s). Fine for a demo, upgrade for real traffic.
- **In-process synthesis.** By default the API synthesises in-process
  (`INLINE_PROCESSING` unset). Work in flight is lost if the free instance
  sleeps or restarts mid-job; `POST /api/documents/:id/process` requeues it. For
  resilience, run the standalone worker (`worker.js`) as a separate Render
  service with `INLINE_PROCESSING=false` and `SUPABASE_SERVICE_ROLE_KEY` set.
- **OCR is off in this deploy** (`--omit=optional` in the API build). Drop that
  flag in `render.yaml` to enable scanned-PDF OCR; expect slower builds.
- **ElevenLabs free tier is 10,000 characters/month.** When it's exhausted,
  synthesis fails with a clear "monthly quota reached" message. Set
  `OPENAI_API_KEY` and pick an OpenAI voice to keep going.
