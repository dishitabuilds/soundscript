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

`ALLOWED_ORIGINS` is already set in `render.yaml` to this deployment's web
origin, so there is nothing to fill in for it.

### `soundscript-web` env vars

| Key                      | Value            |
| ------------------------ | ---------------- |
| `VITE_SUPABASE_URL`      | your project URL |
| `VITE_SUPABASE_ANON_KEY` | anon key         |

`VITE_BACKEND_URL` is already set in `render.yaml` to the API's URL.

## 4. If you rename either service

`render.yaml` hard-codes the two cross-references — `ALLOWED_ORIGINS` (API →
web origin) and `VITE_BACKEND_URL` (web → API URL). They match the default
service names. **Only if you rename a service** (giving it a different
`.onrender.com` URL), update those two values in `render.yaml` to match, or the
browser will get a CORS error. With the default names, there is nothing to do.

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
- **Scanned-PDF OCR is available.** The API does a full `npm ci` (it must —
  pdfjs's `@napi-rs/canvas` ships its native binary as an optional platform
  package that `--omit=optional` would strip), so `tesseract.js` installs too.
  Its ~10MB trained-data model downloads the first time a scanned PDF is
  processed, not at build time.
- **ElevenLabs free tier is 10,000 characters/month.** When it's exhausted,
  synthesis fails with a clear "monthly quota reached" message. Set
  `OPENAI_API_KEY` and pick an OpenAI voice to keep going.
