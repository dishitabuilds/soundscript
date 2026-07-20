<div align="center">

# 🔊 SoundScript

### Turn any document into a narrated audiobook — with chapters, read-along, and a private podcast feed.

[**▶ Live demo**](https://soundscript-web.onrender.com) &nbsp;·&nbsp;
[Report a bug](https://github.com/dishitabuilds/soundscript/issues) &nbsp;·&nbsp;
[Request a feature](https://github.com/dishitabuilds/soundscript/issues)

![Node](https://img.shields.io/badge/Node-22+-3a6a42)
![React](https://img.shields.io/badge/React-19-5b1a16)
![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20RLS-9a6f0e)
![Tests](https://img.shields.io/badge/tests-100%20passing-3a6a42)
![Deploy](https://img.shields.io/badge/deploy-Render-5b1a16)

</div>

---

Upload a **PDF, EPUB, DOCX, or text file** and get back a single MP3 with natural
pauses in the right places, clickable chapters, and read-along highlighting.
Short pasted text can be converted directly too.

The text-to-speech API call is one line in the middle of this system —
**everything that makes the result usable happens on either side of it.** A raw
PDF has no paragraphs, repeats its header on every page, and hyphenates words
across line breaks; TTS APIs cap input length and cost money per character;
synthesis is slow. So SoundScript is really a **document-processing and
job-orchestration pipeline** that happens to end in audio.

## Table of contents

- [Features](#features)
- [Live demo](#live-demo)
- [Architecture](#architecture)
- [The pipeline](#the-pipeline)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Deployment](#deployment)
- [Testing](#testing)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Known limits](#known-limits)

## Features

|                               |                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| 📄 **Multi-format ingest**    | PDF, EPUB, DOCX, TXT, Markdown — format detected from the file's own bytes, not its extension.          |
| 🔎 **Scanned-PDF OCR**        | Falls back to Tesseract when a PDF has no text layer.                                                   |
| 🧹 **Smart cleaning**         | Strips running headers/footers, page numbers, de-hyphenates, and rebuilds paragraphs a PDF never had.   |
| 💰 **Cost estimate first**    | Quotes chunk count, cache hits, and billable characters — and refuses before you blow your daily quota. |
| 🎙️ **Voice picker + preview** | Choose a provider/voice and hear a sample before committing.                                            |
| 📖 **Chaptered audiobook**    | Measured pauses between sentences/paragraphs; every paragraph becomes a clickable chapter.              |
| ✨ **Read-along**             | The spoken sentence is highlighted in step with playback; click any sentence to jump there.             |
| ⏯️ **Real player**            | Playback speed, ±15s skip, cross-device resume.                                                         |
| 🗣️ **Pronunciation rules**    | Per-user find→replace (`"RLS"` → `"R L S"`) applied before synthesis.                                   |
| 🎧 **Private podcast feed**   | Subscribe to your library in any podcast app via a rotatable token URL.                                 |
| 📡 **Live progress**          | An animated pipeline view driven by real server-sent events.                                            |
| 👤 **Guests + accounts**      | Use it instantly as a guest, attach an email later and keep your history.                               |
| 🌗 **Light / dark themes**    | A "Mahogany Library" palette with a persisted theme toggle, fully responsive.                           |

## Live demo

**→ [soundscript-web.onrender.com](https://soundscript-web.onrender.com)**

> Runs on free-tier infrastructure, so the API may take ~30–50s to wake on the
> first request. Sign-in is anonymous — just start using it. Audio generation is
> capped by the connected ElevenLabs free tier (10,000 characters/month).

## Architecture

Two deployable pieces, plus Supabase as the backing platform:

```
┌────────────────┐      ┌──────────────────┐      ┌────────────────────────┐
│  Web (React)   │ ───► │  API (Node/Express) │ ─► │  Supabase              │
│  static Vite   │ ◄─── │  extract · chunk    │    │  Postgres + RLS        │
│  build         │ SSE  │  queue · workers    │    │  Auth (JWT, anon)      │
└──────┬─────────┘      │  stitch (ffmpeg)    │    │  Storage (private)     │
       │ auth           └─────────┬───────────┘    └────────────────────────┘
       └───────────────────────►  │ synthesise
                                   ▼
                        ┌────────────────────┐
                        │ ElevenLabs / OpenAI │
                        └────────────────────┘
```

- **Web** — a static Vite build. Talks to Supabase directly for auth, and to the API for everything else.
- **API** — a **persistent** Node process (not serverless): a 40-page chapter takes minutes to synthesise, and the API streams live progress over long-lived SSE connections. It returns a job id instantly and keeps working in the background.
- **Supabase** — Postgres (holds the work queue and enforces row-level security), Auth (JWT, anonymous sign-in), and Storage (private bucket for audio, served via short-lived signed URLs).

## The pipeline

```
file ──► extract ──► clean ──► rules ──► chunk ──► queue ──► workers ──► stitch ──► audiobook
       (per format)  (pdf)   (per user) (rules)  (postgres)  (N par.)   (ffmpeg)
```

| Stage       | Module                                           | What it does                                                                                                                                             |
| ----------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Extract** | [`lib/extract/`](lib/extract/index.js)           | Detects format from magic bytes. PDF (pdfjs; paragraphs inferred from baseline gaps), EPUB (spine walk), DOCX (paragraph runs), TXT/MD, or OCR fallback. |
| **Clean**   | [`lib/text/clean.js`](lib/text/clean.js)         | PDF only — drops headers/footers found by cross-page repetition, strips page numbers, de-hyphenates, rejoins wrapped lines.                              |
| **Rules**   | [`lib/text/pronounce.js`](lib/text/pronounce.js) | Applies per-user find→replace **before** hashing, so corrected text caches under its own key.                                                            |
| **Chunk**   | [`lib/text/chunker.js`](lib/text/chunker.js)     | Splits at paragraph → sentence → clause → word, descending only when the level above won't fit the API's char cap.                                       |
| **Queue**   | [`supabase/migrations`](supabase/migrations)     | The `chunks` table **is** the queue; `claim_next_chunk()` uses `FOR UPDATE SKIP LOCKED`.                                                                 |
| **Workers** | [`lib/worker/pool.js`](lib/worker/pool.js)       | N workers pull from the shared queue, retry with jittered backoff, write the cache.                                                                      |
| **Stitch**  | [`lib/audio/stitch.js`](lib/audio/stitch.js)     | Concatenates with 0.35s sentence / 0.75s paragraph pauses; emits chapter timestamps and a per-chunk timeline for read-along.                             |

## Tech stack

| Layer                         | Choice                                                                  |
| ----------------------------- | ----------------------------------------------------------------------- |
| **Backend**                   | Node.js 22+, Express (CommonJS)                                         |
| **Frontend**                  | React 19, Vite, Tailwind CSS                                            |
| **Database / Auth / Storage** | Supabase (Postgres + Row-Level Security + Auth + Storage)               |
| **Text-to-speech**            | ElevenLabs (primary), OpenAI (optional) — behind a provider abstraction |
| **Audio**                     | ffmpeg / ffprobe (static binaries) for stitching + measuring            |
| **PDF / EPUB / DOCX / OCR**   | pdfjs-dist + @napi-rs/canvas, adm-zip + fast-xml-parser, tesseract.js   |
| **Deploy / CI**               | Render (Blueprint), GitHub Actions                                      |
| **Tests / quality**           | `node:test` (100 tests), ESLint, Prettier                               |

## Project structure

```
.
├── index.js                 # Express app: routes, CORS, health, error handling
├── worker.js                # Optional standalone queue worker (durable processing)
├── routes/                  # HTTP routes: documents, convert, voices, pronunciations, feed
├── lib/
│   ├── extract/             # PDF / EPUB / DOCX / text / OCR → clean text
│   ├── text/                # clean · chunker · sentences · pronounce
│   ├── tts/                 # provider abstraction (elevenlabs · openai) + retry + cache key
│   ├── audio/               # stitch (ffmpeg) · assemble
│   ├── worker/              # the concurrent worker pool
│   ├── auth.js  supabase.js quota.js events.js feed.js notify.js
├── supabase/migrations/     # schema, RLS policies, RPCs, storage buckets
├── test/                    # 100 unit tests (node:test), in-memory fixtures
├── tts-frontend/            # React + Vite + Tailwind single-page app
├── render.yaml              # Render Blueprint: deploys API + web together
└── DEPLOY.md                # step-by-step deployment runbook
```

## Getting started

**Prerequisites:** Node 22+, a Supabase project, and an ElevenLabs (or OpenAI) API key.

```bash
# 1. Backend
cp .env.example .env          # fill in Supabase + ElevenLabs
npm install
npm start                     # http://localhost:5000

# 2. Frontend (second terminal)
cd tts-frontend
cp .env.example .env          # fill in backend URL + Supabase
npm install
npm run dev                   # http://localhost:5173

# 3. Supabase (schema, RLS, RPCs, buckets)
npx supabase login
npx supabase link --project-ref <your-ref>
npx supabase db push
npx supabase config push      # enables anonymous sign-in
```

## Environment variables

**Backend** (`.env`)

| Key                                  | Required | Notes                                         |
| ------------------------------------ | -------- | --------------------------------------------- |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | ✅       | Project URL + anon key                        |
| `ELEVEN_API_KEY`                     | ✅*      | ElevenLabs key (*or use OpenAI)               |
| `OPENAI_API_KEY`                     | –        | Adds a second voice provider + quota fallback |
| `ALLOWED_ORIGINS`                    | ✅       | Comma-separated allow-list (or `*`)           |
| `DAILY_CHAR_QUOTA`                   | –        | Per-user daily character cap (default 10000)  |
| `SUPABASE_SERVICE_ROLE_KEY`          | –        | Enables the podcast feed + standalone worker  |
| `INLINE_PROCESSING`                  | –        | `false` hands the queue to `worker.js`        |

**Frontend** (`tts-frontend/.env`) — `VITE_BACKEND_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

## Deployment

One [`render.yaml`](render.yaml) Blueprint deploys **both** the API (persistent
Node service) and the web (static Vite build). Push to `main` and Render
auto-redeploys both; GitHub Actions runs tests, lint, and formatting in parallel.
Full step-by-step in **[DEPLOY.md](DEPLOY.md)**.

## Testing

```bash
npm test                      # 100 unit tests, no credentials needed
```

Covers the chunker, sentence boundaries, PDF cleaning, EPUB/DOCX extraction,
format detection, pronunciation rules, retry/backoff, ffmpeg stitching (with
real audio), RSS rendering, and error classification. PDF/EPUB/DOCX fixtures are
**generated in memory** as reviewable code rather than committed as opaque
binaries.

## Design decisions worth knowing

- **Identity comes from the verified JWT, never the request body.** The backend forwards the caller's token so `auth.uid()` resolves and RLS applies as written.
- **Guests are real users.** Anonymous sign-in gives every visitor a real UUID, so RLS, history, and quotas work through one code path — no `user_id = "guest"` special case.
- **Audio is content-addressed.** `sha256(provider:voice:model:text)` is the cache key, so re-uploading an unchanged document costs nothing and finishes instantly.
- **The queue is the `chunks` table**, and `FOR UPDATE SKIP LOCKED` makes concurrent workers safe — two workers asking at once get different rows, never the same one twice.
- **Progress is derived, not counted** — `document_progress()` counts rows rather than incrementing a column, because a counter and the rows it summarises drift apart the first time something fails.
- **The worker pool takes a client rather than making one** — a user-scoped client runs under RLS; a service-role client drains every queue from a standalone process. Only the trigger changes.
- **Estimate and real upload share one code path**, so the confirm screen's cost can never drift from what you're actually charged.

## Known limits

- **In-process synthesis** is lost if the server restarts mid-job (a resume endpoint requeues it); the standalone [`worker.js`](worker.js) with a stale-work reaper is the durable option.
- **SSE progress is per-process** — multiple instances would need a shared channel (Postgres `LISTEN/NOTIFY` or Supabase Realtime).
- **The cache is per-user** — a global cache would save more but leak whether others synthesised the same text.
- **OCR is best-effort** (clean scans, English by default).
- **ElevenLabs' free tier is 10,000 characters/month** — a real chapter is ~100k characters; OpenAI or a paid tier is the way around it.

---

<div align="center">

Built by [**dishita**](https://github.com/dishitabuilds) ·
[Live demo](https://soundscript-web.onrender.com)

</div>
