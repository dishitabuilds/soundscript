# SoundScript

Turn a PDF into a narrated audiobook with chapter markers.

Upload a chapter of notes, get back a single MP3 with pauses in the right places
and clickable chapters. Short text can also be converted directly.

---

## Why it is built this way

The TTS API is one line in the middle of this system. Everything that makes the
result usable happens on either side of it:

- A PDF has no paragraphs, repeats its header on every page, hyphenates words
  across line breaks, and wraps sentences mid-thought. That has to be undone
  before a single character is synthesised.
- TTS APIs cap input length, so a chapter has to be split — and where the splits
  land is audible.
- Synthesis is slow and costs money per character, so the work is queued,
  parallelised, retried, and cached.
- Chunks synthesised in isolation butt together with no breath, so they are
  stitched with measured silence.

## Pipeline

```
PDF ──► extract ──► clean ──► chunk ──► queue ──► workers ──► stitch ──► audiobook
        (pdfjs)              (rules)   (postgres)  (N par.)   (ffmpeg)
```

| Stage   | Module                                     | What it actually does                                                                                                    |
| ------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Extract | [lib/pdf/extract.js](lib/pdf/extract.js)   | Text per page. Infers paragraph breaks by measuring baseline gaps — PDFs contain no blank lines.                         |
| Clean   | [lib/text/clean.js](lib/text/clean.js)     | Drops running headers/footers found by cross-page repetition, strips page numbers, de-hyphenates, rejoins wrapped lines. |
| Chunk   | [lib/text/chunker.js](lib/text/chunker.js) | Splits at paragraph → sentence → clause → word, descending only when the level above will not fit.                       |
| Queue   | [supabase/migrations](supabase/migrations) | `chunks` table is the queue; `claim_next_chunk()` uses `FOR UPDATE SKIP LOCKED`.                                         |
| Workers | [lib/worker/pool.js](lib/worker/pool.js)   | N workers pull from the shared queue, retry with jittered backoff, write the cache.                                      |
| Stitch  | [lib/audio/stitch.js](lib/audio/stitch.js) | Concatenates with 0.35s sentence / 0.75s paragraph pauses; emits chapter timestamps.                                     |

## Design decisions worth knowing

**Identity comes from the verified JWT, never the request body.** The backend
forwards the caller's token to Supabase so `auth.uid()` resolves and RLS applies
as written. An anon key with no user context makes every RLS-protected write
fail silently.

**Guests are real users.** Supabase anonymous sign-in gives every visitor a real
UUID, so RLS, history and quotas work through one code path with no
`user_id = "guest"` special case. Adding an email later keeps the same account
and its history (`updateUser`, not `signUp`).

**Audio is content-addressed.** `sha256(voice:model:text)` is the cache key, so
re-uploading an unchanged document costs nothing and finishes instantly. Cached
chunks are marked `from_cache` because a cache hit and a completed synthesis are
otherwise indistinguishable — and the quota must only charge for real API calls.

**Progress is derived, not counted.** `document_progress()` counts rows rather
than incrementing a column, because a counter and the rows it summarises drift
apart the first time something fails midway.

**The pool takes a client rather than making one.** Given a user's client it
works under RLS; given a service-role client it could drain every queue from a
standalone process. Only the trigger would change.

## Running it

```bash
# backend
cp .env.example .env        # fill in Supabase + ElevenLabs
npm install
npm start                   # http://localhost:5000

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

## Tests

```bash
npm test              # 68 unit tests, no credentials needed
```

Covers the chunker, sentence boundaries, PDF cleaning, retry/backoff, and ffmpeg
stitching. PDFs are generated in-memory by [test/helpers/make-pdf.js](test/helpers/make-pdf.js)
rather than committed as opaque binaries.

Integration scripts hit the real database and spend real credits, so they are
manual:

```bash
npm run verify:schema     # RLS isolation, concurrent claiming, storage
node scripts/verify-documents.js
node scripts/verify-worker.js
node scripts/verify-sse.js
```

## Known limits

- **Synthesis runs in-process**, fire-and-forget after the response. Work in
  flight is lost if the server restarts; `POST /api/documents/:id/process`
  requeues it. This rules out serverless platforms that kill the function once
  the response is sent.
- **Progress events are per-process.** Two instances behind a load balancer
  would need a shared channel (LISTEN/NOTIFY or Supabase Realtime).
- **The cache is per-user.** A global cache would save more calls but would leak
  whether another user had synthesised the same text.
- **Scanned PDFs produce nothing** — there is no OCR, so image-only pages have
  no text to extract.
- **Cleaning is heuristic.** It is tuned for prose and will not do anything
  sensible with a spreadsheet or a table-heavy page.
- **ElevenLabs' free tier is 10,000 characters/month.** A real 40-page chapter is
  roughly 100k characters and will not fit at any quota setting.
