# SoundScript

Turn a document into a narrated audiobook with chapter markers.

Upload a PDF, EPUB, DOCX or text file, get back a single MP3 with pauses in
the right places, clickable chapters, read-along highlighting, and a private
podcast feed your podcast app can subscribe to. Short text can also be
converted directly.

**Deploying?** See [DEPLOY.md](DEPLOY.md), or one-click the API + web frontend:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dishitabuilds/soundscript)

---

## Why it is built this way

The TTS API is one line in the middle of this system. Everything that makes the
result usable happens on either side of it:

- A PDF has no paragraphs, repeats its header on every page, hyphenates words
  across line breaks, and wraps sentences mid-thought. That has to be undone
  before a single character is synthesised. (EPUB and DOCX carry real
  paragraphs, so they skip the guesswork.)
- TTS APIs cap input length, so a chapter has to be split — and where the splits
  land is audible.
- Synthesis is slow and costs money per character, so the work is queued,
  parallelised, retried, and cached — and quoted to the user _before_ it is
  spent.
- Chunks synthesised in isolation butt together with no breath, so they are
  stitched with measured silence, and the stitch records where every chunk
  landed so the text can follow the audio.

## Pipeline

```
file ──► extract ──► clean ──► rules ──► chunk ──► queue ──► workers ──► stitch ──► audiobook
        (per format)  (pdf)   (per user) (rules)  (postgres)  (N par.)   (ffmpeg)
```

| Stage   | Module                                         | What it actually does                                                                                                                                                                       |
| ------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extract | [lib/extract/](lib/extract/index.js)           | Format detected from the file's own bytes. PDF measures baseline gaps; EPUB walks the spine; DOCX reads paragraph runs; scanned PDFs fall back to OCR when the optional deps are installed. |
| Clean   | [lib/text/clean.js](lib/text/clean.js)         | PDF only: drops running headers/footers found by cross-page repetition, strips page numbers, de-hyphenates, rejoins wrapped lines.                                                          |
| Rules   | [lib/text/pronounce.js](lib/text/pronounce.js) | Per-user find→replace fixes ("RLS" → "R L S"), applied before hashing so corrections cache under their own keys.                                                                            |
| Chunk   | [lib/text/chunker.js](lib/text/chunker.js)     | Splits at paragraph → sentence → clause → word, descending only when the level above will not fit.                                                                                          |
| Queue   | [supabase/migrations](supabase/migrations)     | `chunks` table is the queue; `claim_next_chunk()` uses `FOR UPDATE SKIP LOCKED`.                                                                                                            |
| Workers | [lib/worker/pool.js](lib/worker/pool.js)       | N workers pull from the shared queue, retry with jittered backoff, write the cache. Speaks through [lib/tts/](lib/tts/index.js) — ElevenLabs or OpenAI, chosen per document.                |
| Stitch  | [lib/audio/stitch.js](lib/audio/stitch.js)     | Concatenates with 0.35s sentence / 0.75s paragraph pauses; emits chapter timestamps and a per-chunk timeline for read-along.                                                                |

## Design decisions worth knowing

**Identity comes from the verified JWT, never the request body.** The backend
forwards the caller's token to Supabase so `auth.uid()` resolves and RLS applies
as written. An anon key with no user context makes every RLS-protected write
fail silently.

**Guests are real users.** Supabase anonymous sign-in gives every visitor a real
UUID, so RLS, history and quotas work through one code path with no
`user_id = "guest"` special case. Adding an email later keeps the same account
and its history (`updateUser`, not `signUp`).

**Audio is content-addressed.** `sha256(provider:voice:model:text)` is the cache
key, so re-uploading an unchanged document costs nothing and finishes instantly.
Cached chunks are marked `from_cache` because a cache hit and a completed
synthesis are otherwise indistinguishable — and the quota must only charge for
real API calls. Voice previews ride the same cache: each voice is paid for once
per user, ever.

**Estimates and uploads share one code path.** `POST /api/documents` with
`estimate` set runs the identical extract→rules→chunk→cache-probe pipeline and
writes nothing, so the confirm screen's numbers cannot drift from what the real
upload would bill.

**Progress is derived, not counted.** `document_progress()` counts rows rather
than incrementing a column, because a counter and the rows it summarises drift
apart the first time something fails midway.

**The pool takes a client rather than making one.** Given a user's client it
works under RLS; given a service-role client it drains every queue — which is
exactly what [worker.js](worker.js) does. The promised "only the trigger
changes" held.

**The feed token is the auth.** Podcast apps cannot send an Authorization
header, so the private feed URL carries a rotatable bearer token, resolved with
the service-role key. Enclosures are signed storage URLs with a multi-day
expiry, because podcast apps fetch the feed now and the audio later.

## Running it

```bash
# backend
cp .env.example .env        # fill in Supabase + ElevenLabs (OpenAI optional)
npm install
npm start                   # http://localhost:5000

# optional: durable processing (survives API restarts)
#   set INLINE_PROCESSING=false and SUPABASE_SERVICE_ROLE_KEY in .env, then:
npm run worker              # claims queued jobs, reaps stranded work

# frontend
cd tts-frontend
cp .env.example .env
npm install
npm run dev                 # http://localhost:5173
```

Supabase setup:

```bash
npx supabase login
npx supabase link --project-ref <your-ref>
npx supabase db push        # schema, RLS, RPCs, buckets
npx supabase config push    # auth settings incl. anonymous sign-in
```

Optional features, each off until its key exists:

| Feature                      | Enable with                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI voices in the picker  | `OPENAI_API_KEY`                                                                                                                                 |
| Scanned-PDF OCR              | `npm install` already pulls `tesseract.js` + `@napi-rs/canvas` (optionalDependencies); use `npm ci --omit=optional` to skip them on lean deploys |
| Podcast feed                 | `SUPABASE_SERVICE_ROLE_KEY`                                                                                                                      |
| Standalone worker            | `SUPABASE_SERVICE_ROLE_KEY` + `INLINE_PROCESSING=false`                                                                                          |
| "Ready" emails (worker only) | `RESEND_API_KEY`                                                                                                                                 |

## Tests

```bash
npm test              # 94 unit tests, no credentials needed
```

Covers the chunker, sentence boundaries, PDF cleaning, EPUB/DOCX extraction,
format detection, pronunciation rules, retry/backoff, ffmpeg stitching with
chapter + timeline output, and RSS rendering. PDFs are generated in-memory by
[test/helpers/make-pdf.js](test/helpers/make-pdf.js) and EPUB/DOCX fixtures are
assembled as zips inside the tests rather than committed as opaque binaries.

Integration scripts hit the real database and spend real credits, so they are
manual:

```bash
npm run verify:schema     # RLS isolation, concurrent claiming, storage
node scripts/verify-documents.js
node scripts/verify-worker.js
node scripts/verify-sse.js
```

## Known limits

- **Inline mode loses in-flight work on restart** (`INLINE_PROCESSING=true`,
  the default). `POST /api/documents/:id/process` requeues it manually. Run the
  standalone worker for automatic recovery — its reaper requeues anything
  stranded longer than `WORKER_STALE_MINUTES`.
- **Progress events are per-process.** Two API instances behind a load balancer
  would need a shared channel (LISTEN/NOTIFY or Supabase Realtime). Jobs
  finished by the standalone worker report progress on refetch, not live SSE,
  for the same reason.
- **The cache is per-user.** A global cache would save more calls but would leak
  whether another user had synthesised the same text.
- **OCR is best-effort.** Tesseract on a rendered page handles clean scans;
  photographed pages and unusual scripts will come out garbled. English
  (`OCR_LANG=eng`) by default.
- **Cleaning is heuristic** for PDFs. It is tuned for prose and will not do
  anything sensible with a spreadsheet or a table-heavy page. EPUB tables get
  one line per row.
- **ElevenLabs' free tier is 10,000 characters/month.** A real 40-page chapter
  is roughly 100k characters and will not fit at any quota setting. The OpenAI
  provider or a paid tier is the way around it.
