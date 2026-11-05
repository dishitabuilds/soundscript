# Deploying SoundScript

Two pieces ship together from this repo via [render.yaml](render.yaml): the
**API** (a persistent Node service) and the **web** frontend (a static Vite
build). This runbook covers the steps that can only happen in your accounts —
review the [verification report](docs/verification-report.md) before considering this production-ready.

## 0. Prerequisites

- A GitHub account, a Render account, and a Supabase project (the same one you
  linked locally, or a fresh production project).
- At least one speech provider. For quota fallback, use ElevenLabs with a
  reachable [Kokoro service](docs/free-speech.md).

## 1. Put the repo on GitHub

If the repository has no remote, create an empty repository in your account, then:

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

| Key                         | Value                                                         |
| --------------------------- | ------------------------------------------------------------- |
| `SUPABASE_URL`              | Production project URL                                        |
| `SUPABASE_ANON_KEY`         | Production anon key                                           |
| `ELEVEN_API_KEY`            | ElevenLabs key                                                |
| `OPENAI_API_KEY`            | Optional OpenAI speech and generated answers                  |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional podcast feed                                         |
| `KOKORO_URL`                | HTTPS URL of the deployed Kokoro speech service               |
| `KOKORO_SERVICE_TOKEN`      | Token matching the Kokoro service                             |
| `TTS_PROVIDER`              | `auto` to fall back from ElevenLabs quota to Kokoro           |
| `RAG_ENABLED`               | Set by the Blueprint. Apply the document RAG migration first. |
| `RAG_MODEL_URL`             | Optional HTTPS URL of the embedding and reranking service     |
| `RAG_MODEL_TOKEN`           | Token matching the model service                              |
| `RAG_ANSWER_MODEL`          | Optional answer model to use with the OpenAI key              |

`ALLOWED_ORIGINS` is already set in `render.yaml` to this deployment's web
origin, so there is nothing to fill in for it.

The Blueprint deploys the web and API. Deploy the optional Python services
separately and configure their URLs on the API. The API uses lexical search
with source excerpts when RAG is enabled and the model URL is unset.
See the [study assistant setup](docs/ai-study-assistant.md) and
[validated CPU profile](docs/reviewed-ranking.md) for the model service.
Automatic deploys wait for the linked branch's CI checks.

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

- `https://soundscript-api-55nk.onrender.com/api/health` → `{"ok":true, ...}`. Check
  the `revision` and enabled features. Add `?debug=1` to check whether Supabase Auth answers.
- Open the web URL, upload a small document, confirm it narrates end to end.

## Notes & gotchas

- **Free-plan cold starts.** Render's free web service sleeps after inactivity;
  the first API request can take about a minute. The static web page renders
  while the browser connects to Supabase Auth.
- **Database activity.** [Production database check](.github/workflows/keepalive.yml)
  makes four database reads per day through the live API to reduce Supabase
  inactivity pauses. It lets Render sleep between checks to preserve shared
  free instance hours. GitHub can disable scheduled workflows after 60 days of
  inactivity in a public repository. If a check fails, verify both services
  and resume Supabase from its dashboard if it was paused.
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
- **ElevenLabs quota.** With a deployed Kokoro service and the `auto` provider,
  synthesis falls back to Kokoro when ElevenLabs returns a quota error.
