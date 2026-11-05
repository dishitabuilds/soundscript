# SoundScript verification report

3 November 2026 · branch: codex/soundscript-verification

## 1. Project health

**Overall: improved and verified locally; not production-ready.**

Frontend: lint, API-client tests and production build pass. The real React
application completed a disposable TXT upload, estimate, queued conversion,
FFmpeg assembly, playback and download in the browser. Backend: automated
tests cover all HTTP authentication gates and route contracts, extraction,
speech providers, queue behavior, caching and assembly.

Supabase: mocked for repeatable testing. Production table definitions, RLS,
storage policies, transactions and two-user isolation were not modified or
verified against a disposable database. The standalone worker entry point,
crash recovery and cross-process claims still need database-backed testing.

Deployment: frontend HTML and backend health returned HTTP 200. The live
keepalive route returned HTTP 404, despite existing locally. Runtime logs,
production schema, worker execution and deployment settings are BLOCKED:
there is no connected Render administration session, and no production
administrative database access was used. Health booleans prove presence only.

No changes were committed, pushed or deployed. Existing user documents and
developer-guide files were left alone.

## 2. Credentials and ElevenLabs

The application uses the existing ELEVEN_API_KEY name. No key was rotated,
replaced, printed, logged or committed. Backend and frontend environment files
were preserved. Git now ignores .env and .env.* at every directory depth,
with .env.example templates explicitly allowed.

Read-only live checks:

- API key configured: YES.
- Authentication: PASS, GET /v1/user returned HTTP 200.
- Subscription: PASS, free account; GET /v1/user/subscription returned 200.
- Quota: PASS; 0 used and 10,000 remaining **before** the approved speech test.
  The exact post-test balance and credit charge were not queried.
- Configured voice: PASS, GET /v1/voices/{configuredVoice} returned 200.
- Configured model: PASS, models response included the configured TTS-capable
  model and a maximum request length of 40,000 characters.
- Permissions: PASS for the exercised account reads and synthesis. All other
  permission scopes, key-specific concurrency and dashboard/IP restriction
  configuration remain BLOCKED. Requests worked from this machine.
- Mocked generation: PASS. Tests verify endpoint, xi-api-key header, payload,
  output format, timeout, error classification and binary response handling.
- Real generation: PASS after explicit user approval. Exactly one request
  spoke “Hello SoundScript.” (18 characters). It returned 19,687 bytes of MP3,
  duration 1.201633 seconds, and FFmpeg decoded it successfully.
- Production configuration: PARTIAL/BLOCKED. Live health reports ElevenLabs
  configured; no production speech request or secret inspection was performed.

The live sample is saved locally at ../.audit/elevenlabs-sample.mp3 and ignored
by Git. It was not uploaded to production storage. The browser journey used
synthetic audio and in-memory Supabase; it is separate evidence from the one
real provider request.

The request shape was checked against the official
[speech endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/convert),
[authentication](https://elevenlabs.io/docs/api-reference/authentication),
[user endpoint](https://elevenlabs.io/docs/api-reference/user/get),
[subscription endpoint](https://elevenlabs.io/docs/api-reference/user/subscription/get)
and [model listing](https://elevenlabs.io/docs/api-reference/models/list).
Speech uses the documented MP3 output format explicitly. Raw account responses
and Axios request objects are never printed by the verification script.

## 3. Feature verification

- PDF: PASS for generated text, multipage, paragraphs, headers and invalid-file
  fixtures. Input buffers now survive PDF.js worker transfer. Complex
  multicolumn layouts, encrypted documents and a large real-world corpus
  remain NOT TESTED; PDF reading order is still heuristic.
- EPUB: PASS for archive recognition, spine ordering, paragraph extraction and
  invalid archives. Entry count and expanded-size limits are enforced.
- DOCX: PASS for ordinary paragraphs, links, tables, wrapped content and line
  breaks. No Office installation is required.
- TXT/Markdown: PASS for short files, Unicode decoding, paragraph boundaries,
  literal TXT punctuation and binary/invalid-UTF-8 rejection.
- OCR: PASS for mocked recognition over real rendered PDF images and one real
  Tesseract recognition of a generated mixed PDF. Text pages are preserved;
  text-only and deliberately blank pages do not trigger OCR. Initialization
  errors and error callbacks are tested. Accuracy on arbitrary scans/languages
  remains unverified.
- Text cleaning and chunking: PASS for existing sentence, paragraph, reading
  order, splitting and no-text-loss fixtures.
- ElevenLabs: PASS for mocked failures and the one approved live generation.
  OpenAI's request/error handling is mocked; no OpenAI key is configured.
- FFmpeg: PASS for real local concatenation, duration probing, pauses, chapter
  timestamps, timeline ordering, scratch cleanup and missing-binary failure.
- Caching: PASS for stable keys, voice/model/provider separation, per-user
  paths, repeated chunks, in-process duplicate coalescing and failed uploads.
  Cross-process duplicate suppression and stale-object repair remain open.
- Background jobs: PASS with mocked database claims, attempt bounds, failed
  reads/writes and progress truthfulness. Restart and reaper safety are open.
- Playback: PASS in the local real browser application with synthetic audio.
- Downloads: PASS for the local audiobook attachment. The downloaded MP3 was
  probed and decoded successfully. Signed-download options have an automated
  frontend contract test.
- History/account linking/mobile layout: source inspected; complete browser
  workflows, persistent sessions and responsive-device checks remain NOT TESTED.
- Podcast feeds: XML rendering unit tests and disabled/unknown-token HTTP
  behavior pass; live feeds are disabled without a service-role key.

## 4. API inventory and evidence

PASS below means the stated **local mocked** checks passed, not a production
integration certification. All 16 protected route/method combinations reject
both missing and invalid authentication with HTTP 401.

- GET / — public availability; no input; text response. PASS HTTP 200.
- GET /api/health — public dependency presence; optional debug=1; JSON flags.
  PASS local 200 and live 200. Live diagnostic auth was not exercised.
- GET /api/keepalive — public read-only database probe; JSON result.
  PASS local 200/503 handling; FAIL live 404.
- POST /api/convert — authenticated short text; JSON text; audioUrl/cached
  response. PASS input errors, authentication, real-browser synthetic success
  and provider request tests. Legacy public bucket privacy remains an issue.
- POST /api/documents — authenticated multipart file/settings or JSON text;
  optional estimate; returns estimate or document/job/chunk metadata.
  PASS short TXT, unsupported extension 415, oversized upload 413, binary
  rejection 400, typed-field validation, read-only estimate and 201 queueing.
  Browser upload/processing PASS. Other format parsers are tested separately.
- GET /api/documents — authenticated library; no body; documents array.
  PASS success and database-error handling.
- GET /api/documents/:id — authenticated ownership-filtered detail; document,
  progress, job, asset and position. PASS success and missing document 404.
  Real database ownership enforcement remains BLOCKED.
- GET /api/documents/:id/text — authenticated ordered chunk text.
  PASS populated text response and browser read-along.
- PUT /api/documents/:id/position — authenticated numeric seconds; HTTP 204.
  PASS numeric position and invalid/null/string/negative values 400.
- GET /api/documents/:id/events — authenticated SSE; no JWT in query string.
  PASS snapshot, terminal event and stream closure.
- POST /api/documents/:id/process — authenticated retry; job response.
  PASS active job 409, missing document 404 and queued retry 202.
- DELETE /api/documents/:id — authenticated deletion; HTTP 204.
  PASS mocked row deletion. Actual Postgres cascade/storage cleanup unverified.
- GET /api/voices — authenticated provider/voice list. PASS missing-provider
  fallback behavior; live configured voice separately verified read-only.
- POST /api/voices/preview — authenticated settings; raw MP3 and cache header.
  PASS auth and unavailable-provider failure. Successful preview route and
  preview quota accounting remain unverified/open; no paid preview was made.
- GET /api/pronunciations — authenticated rules array. PASS.
- POST /api/pronunciations — authenticated pattern/replacement; saved rule.
  PASS creation and empty-pattern 400.
- DELETE /api/pronunciations/:id — authenticated rule deletion; 204. PASS.
- GET /api/feed — authenticated feed URL creation/read; enabled flag. PASS
  local disposable token creation and disabled flag.
- POST /api/feed/rotate — authenticated token replacement; new URL. PASS
  disposable local rotation; no production token changed.
- GET /feeds/:token.xml — URL-token authentication; RSS XML or 404.
  PASS disabled/unknown-token behavior; RSS construction separately unit tested.

Malformed JSON and non-object JSON return 400; oversized JSON returns 413.
Configured local-origin CORS passes and an untrusted origin is rejected 403.
These tests do not constitute abuse-load, penetration or real RLS testing.

## 5. Architecture and changes

See the pre-change [architecture review](architecture-review.md).

The existing two-application layout is retained. Express construction moved to
app.js; index.js still loads dotenv and owns listening/process handlers. This
allows real HTTP tests without startup side effects or real credentials.
No broad directory migration was performed.

Other new boundaries are lib/extract/archive.js for bounded archive reads,
test/helpers for disposable fixtures, and scripts/browser-fixture.js for
repeatable browser verification. Speech providers retain their common
interface. Existing ElevenLabs cache hashes and public API response contracts
are preserved.

```text
app.js                     Express routes and HTTP middleware
index.js                   dotenv, listener and process lifecycle
worker.js                  existing standalone worker
routes/                    convert, documents, voices, rules, feeds
lib/
  extract/                 PDF, OCR, EPUB, DOCX, HTML, bounded archives
  text/                    clean, chunk, sentences, pronunciation
  tts/                     providers, errors, retry, hashes
  audio/                   assembly and FFmpeg stitching
  worker/                  database-backed chunk pool
test/                      backend unit and mocked integration tests
tts-frontend/src/          existing React application
tts-frontend/test/         frontend API contract tests
scripts/                   explicit verification and local browser fixture
docs/                      architecture, findings and migration proposal
supabase/migrations/       existing migration history; not applied
```

## 6. Bugs fixed and verification

1. Secret variants were not all ignored. Root ignore rules now cover .env.*
   everywhere and preserve examples. Git ignore/tracking checks verify this.
2. DOCX only read direct paragraphs and glued words across line breaks.
   Ordered recursive paragraph traversal and explicit breaks fix this.
   Two regression cases failed before the fix and pass afterward.
3. Short TXT files failed, binary TXT passed, and TXT punctuation was stripped.
   Short-file detection, strict UTF-8/control checks and Markdown-only stripping
   fix these. Four regression tests reproduced the failures.
4. Out-of-range HTML numeric entities crashed extraction. Unicode range checks
   preserve unknown/invalid entities. The regression test now passes.
5. Archives had no expansion budget. Entry/total/count checks run before
   decompression, using patched adm-zip. Oversized DOCX rejection is tested.
6. PDF.js detached source buffers; mixed PDFs lost scanned pages. Copying
   parser inputs, detecting image-only pages and selective OCR fix these.
   Rendered mixed-PDF tests and real recognition verified both page types.
7. OCR initialization could crash or strand a request. Worker event errors and
   a 60-second initialization bound now reach normal error handling; acquired
   workers and PDF tasks are cleaned. Tesseract can still retain an internal
   worker when initialization never settles; process isolation remains open.
8. Speech accepted invalid success payloads and retried exhausted quota.
   MP3 header/signature checks, permanent quota classification and HTTP-date
   Retry-After parsing are verified with mocked provider responses.
9. Prototype provider names and non-string settings were accepted. Explicit
   registry membership and identifier validation reject them before requests.
10. Short conversions hashed the wrong provider defaults. Hashing and synthesis
    now use the same resolved provider/voice/model settings.
11. Concurrent identical chunks could pay twice in one process. Per-user/hash
    coalescing reuses the completed output; concurrent and repeat-hit tests pass.
12. Failed database reads/writes could result in wrong default voices or false
    job success. Errors now surface, workers finish before finalization, and
    every chunk must be done. Failure-injection tests pass.
13. Service workers trusted user-editable document references and storage paths.
    Explicit document ownership, cache bucket/path checks, assembly ownership
    checks and SHA-256 path validation reject forged references and traversal.
    These defenses do not replace the pending database security migration.
14. JSON parser errors became 500 and typed document fields were unchecked.
    Client error codes and input validation are verified over real local HTTP.
15. Separate workers could not update the frontend's process-local SSE stream,
    and a retry did not reopen a closed stream. Polling and retry reconnection
    are implemented. Cross-process operation still requires a real worker test.
16. Out-of-order estimates could replace newer voice estimates. Quote generation
    tracking discards stale responses and cancelled requests.
17. Cross-origin download attributes are insufficient to force an audiobook
    attachment. Signed download filenames now request attachment disposition.
    Frontend contract tests and the real local browser download both pass.
18. Position save responses were ignored. Failures now reject; a regression
    test reproduced the old silent failure and passes after the fix.
19. Upload controls, voice pickers and read-along lacked keyboard/accessible
    names. Basic labels, roles and key handling were added; a complete
    assistive-technology audit remains open.
20. Dependency advisories included critical/high findings. Compatible updates,
    aligned canvas bindings, a patched qs override and Node's built-in dev
    watcher removed backend findings. Lockfiles preserve the tested versions.

## 7. Test results and reproducibility

Baseline backend: 100 passed. Current backend: 170 tests (70 added).
Frontend: 8 tests added. Total: **178 automated tests**, plus manual browser,
real OCR, one approved live speech check and read-only deployment probes.
Final validation: **178 passed, 0 failed, 0 skipped** (170 backend + 8
frontend). Frontend lint, production build, repository formatting and Git
whitespace checks passed. Both original .env files matched their initial
SHA-256 digests byte for byte; no digest or secret is included in this report.
Only the two .env.example templates are tracked by Git.

Exact direct dependency ranges and installed versions are recorded in
[dependency inventory](dependencies.md); lockfiles record the complete
transitive graph.

Run from the repository:

```bash
npm ci
npm test
cd tts-frontend
npm ci
npm test
npm run lint
npm run build
```

Routine tests do not load .env or contact speech/database providers. Test-only
process variables are synthetic and do not change environment files or the
parent shell. HTTP tests require loopback networking. FFmpeg tests require
the installed platform binary; OCR unit tests mock recognition model loading.

Backend suites: original 100; extraction regressions 8; mocked providers 11;
HTTP integration 29; worker/cache/ownership 15; OCR 6; unavailable FFmpeg 1.
Frontend API-client suite: 8.

The browser fixture uses real application routes, parsers, queue code and
FFmpeg with in-memory Supabase and synthetic MP3s. A TXT document produced two
ordered chunks and chapters. Playback entered the playing state. Clicking
Download saved browser-sample.mp3; FFmpeg decoded that file and reported
1.201633 seconds. Evidence: ../.audit/browser-audiobook.png.

Dependency audit before fixes: backend 12 findings (1 critical, 8 high,
3 moderate); frontend 18 (13 high, 4 moderate, 1 low).
After fixes: backend 0; frontend 6 moderate development-tool findings through
the ESLint/minimatch chain, with no compatible fix reported by npm.

The first local fixture restart was temporarily blocked by approval-review
usage limits. After the stated reset time, normal approval review succeeded
and final browser/download verification completed. No approval was bypassed.

CI now runs backend tests, frontend tests, lint, build, formatting, and npm
audits that fail on high/critical findings. No workflow was pushed or executed
on GitHub during this audit. TypeScript checking is NOT APPLICABLE: this is
a JavaScript repository; no TypeScript migration was introduced.

## 8. Remaining issues

CRITICAL:

- Database queue/cache/quota fields remain writable by their authenticated
  owners. Application defenses now reject cross-owner paths, but direct writes
  can still bypass quota accounting, forge completion state or corrupt owned
  jobs. A trusted-server authorization boundary and migration are required.

HIGH:

- Quota checks are not atomic reservations. Concurrent requests can exceed
  limits; deleting conversion history lowers measured usage; preview synthesis
  is not included; guest identities can be recreated. Provider-wide safeguards
  and server-owned usage accounting are needed.
- A valid long job can be reclaimed by the standalone stale-work reaper because
  jobs have no heartbeat/lease renewal. Multiple active jobs per document can
  race. Inline jobs can be stranded by restart or session expiry.
- The committed migration chain assumes tts_conversions already exists and
  cannot bootstrap a fresh database by itself.
- Legacy short-conversion audio uses a public bucket. Existing permanent links
  need an approved private-storage/history migration.
- Production schema/RLS/storage behavior, deployed OCR/FFmpeg and full live
  document flow remain unverified. Live keepalive currently returns 404.
- Parsing/OCR runs in the API process. Limits help, but CPU/time isolation,
  upload abuse controls and global memory/concurrency budgets are incomplete.
  Tesseract initialization failure can retain an internal worker; a dedicated
  subprocess with hard timeout/termination is the reliable next boundary.

MEDIUM:

- Duplicate suppression is in-process only; two API/worker processes can still
  synthesize identical uncached text twice.
- Cache records can outlive storage objects. Corruption may fail assembly
  repeatedly without a repair/invalidation path.
- Document deletion leaves original sources/assembled storage objects;
  shared cached chunks need reference-aware cleanup and retention rules.
- Several route reads ignore secondary Supabase errors and not every async
  Express 4 handler forwards unexpected promise rejection to middleware.
- Six moderate frontend development-tool advisories remain.
- Long/complex document resource measurements, real database concurrency/load
  tests, full authentication/history flows and mobile/accessibility testing
  remain unverified.

LOW:

- Health reports feature presence rather than end-to-end readiness.
- Static voice fallbacks can differ from actual account availability.
- Short-conversion public-link download behavior has not been verified in the
  final browser run; the document audiobook download was verified.

## 9. Production readiness and approval boundary

**Do not treat this branch as ready for production deployment.**

The local fixes and evidence are reviewable. The next significant change is
the [database and worker hardening proposal](hardening-proposal.md), which
requires approval before implementing the migration. It must first be tested
on a disposable Supabase project. No production database, deployment, keys or
environment settings should be changed as part of that approval.

After migration approval and staging verification, production deployment and
any further paid speech generation still require separate explicit permission.
