# SoundScript architecture review

Reviewed 3 November 2026. Baseline: commit `760ce3f`, branch
`codex/soundscript-verification`. This report precedes substantive changes.

## Existing design

The repository contains two npm applications. The backend is Node 22+,
CommonJS, Express 4; the frontend is React 19, Vite 7 and Tailwind 3.
Supabase supplies JWT authentication (including anonymous users), Postgres,
row-level security and object storage. `render.yaml` defines a persistent API
and a static frontend. `worker.js` is optional and is not provisioned by that
Blueprint. No TypeScript compiler is configured.

Document flow: authenticated upload or pasted text → magic-byte format
detection → PDF/EPUB/DOCX/text extraction → PDF cleanup → pronunciation rules →
paragraph-aware chunking → voice/model/provider hashes → per-user cache lookup
and quota estimate → document/chunk/job rows → concurrent worker pool →
ElevenLabs or OpenAI speech requests → private chunk storage → FFmpeg
assembly → asset metadata → signed playback/download URLs.

The short-text converter instead uses `tts_conversions` and the public
`tts-bucket`. The podcast feed uses revocable URL tokens and a service client.
The worker uses atomic chunk claims and a separate atomic job claim. SSE uses
an in-process event emitter. Database polling in the frontend supplements SSE.

## Baseline evidence

- `npm test`: 100 passed, no failures or skipped tests.
- Frontend `npm run lint`: passed.
- Frontend `npm run build`: passed; browser compatibility datasets are old.
- Existing tests cover extraction, cleaning, chunking, speech error
  classification/retry, FFmpeg assembly and RSS. They do not exercise HTTP
  routes, the database-backed pool, browser interactions or live credentials.
- Backend `.env` and frontend `.env` exist and contain configured required
  variables. Only presence was reported. Their original byte hashes are held
  outside project files for a final unchanged check.
- No `.env` secret file is tracked. The existing ignore rules missed variants
  such as `.env.production`; this has been corrected, preserving example files.

## Confirmed code-level concerns

- DOCX reads only direct body paragraphs, omitting tables and wrapped content.
- TXT uploads shorter than four bytes fail detection; binary bytes renamed
  `.txt` pass; markdown stripping also alters ordinary TXT prose.
- OCR only runs when the entire PDF lacks text, omitting scanned pages in a
  mixed document. OCR worker initialization can leave a PDF task undisposed.
- EPUB/DOCX archives have no expanded-size or entry-count limits.
- Speech synthesis accepts empty/JSON/non-audio success bodies. Permanent
  quota failures returned as 429 are retried. Retry-After dates are not parsed.
- Short conversions hash ElevenLabs defaults even when the default provider
  is OpenAI. Concurrent identical chunks can both pay before either caches.
- Worker reads ignore some database errors and may fall back to the wrong
  voice settings. Final progress does not explicitly require all chunks done.
- HTTP JSON parser errors become 500; route payloads are inconsistently typed.
- Voice previews are absent from rolling quota accounting; quota checks and
  spending are not atomic across concurrent requests.
- A long running job has no heartbeat: the standalone reaper can reclaim a
  healthy job older than its stale threshold. Inline restart recovery is limited.
- The first committed migration assumes `tts_conversions` already exists,
  preventing a clean database bootstrap from migrations alone.
- RLS checks each row's `user_id`, without verifying that a referenced
  document belongs to that user. Browser database write permissions also
  permit tampering with queue/cache fields the backend trusts.
- `tts-bucket` is intentionally public; existing short conversions are not
  private. Changing that requires a storage/data migration and history changes.
- Deleting documents leaves source and assembled storage objects; cache
  entries have no expiry or storage-corruption repair lifecycle.
- Deployment documentation names an older API host; the Blueprint and
  frontend fallback use `soundscript-api-55nk.onrender.com`.

These are source findings, not claims about the currently deployed database.
Runtime failures and fixes must be backed by additional tests.

## Proposed direction

Keep the existing two-application repository and database-backed queue.
Moving these small modules into a monorepo framework or adding a message
broker would not solve the observed problems. Retain public HTTP contracts,
the current environment variable names, and existing cache key formats.

Safe incremental work: add regression tests, bound archive extraction, preserve
document text, validate provider responses and inputs, fail jobs honestly on
database errors, and coalesce identical in-process synthesis. A small `app.js`
module can separate Express construction from listening/process handlers for
credential-free HTTP tests. This leaves existing entry points intact.

```text
index.js                 process startup and listener
app.js                   Express app and HTTP error handling
worker.js                standalone worker entry point
routes/                  existing HTTP contracts
lib/extract/             parsers and bounded archive reader
lib/tts/                 existing provider interface and response validation
lib/text/                existing cleaning/chunking/rules
lib/audio/               existing assembly/stitching
lib/worker/              existing queue pool
test/                    unit and mocked HTTP/worker integration tests
docs/                    architecture and verification evidence
tts-frontend/            existing React application
supabase/migrations/     existing schema history
```

## Changes requiring a separate approved migration

Before production use, design and test a database transaction for quota
reservations, server-owned queue/cache writes, ownership constraints, one
active job per document and chunk/job leases with heartbeats. Include a
bootstrap migration for `tts_conversions`, private short-conversion storage
with signed history URLs, and a referenced-object cleanup policy.

Do not apply these to production or restructure the database without approval.
First prove the migration against a disposable Supabase instance, including
two-user isolation, concurrent claims, quota races and crash recovery. No
production credentials, database rows or environment settings will be changed
by this audit. Paid speech generation and deployment also require approval.
