# Proposed database and worker hardening

Status: proposed, not implemented or applied. Review alongside the
[verification report](verification-report.md). The existing architecture can
stay; these changes address authority, accounting and recovery.

## Intended result

Only trusted backend/worker code can reserve quota, change synthesis state or
publish cache/assets. A user's JWT still owns library reads, playback, rules
and preferences. One active document job has a renewable lease. Crashes recover
without reclaiming healthy long jobs. Cached speech remains per-user.

## Concrete changes requiring approval

1. Bootstrap the missing tts_conversions table in a prerequisite migration
   before the current alter-table history. Validate the complete migration
   chain on an empty disposable project without editing applied migrations.
2. Add document-owner integrity constraints to chunks, jobs, assets and
   listening positions. Validate existing rows before applying constraints;
   produce a conflict report rather than deleting or rewriting user data.
3. Introduce a server-owned usage ledger/reservation transaction shared by
   short conversions, previews and documents. Reserve before requesting speech,
   finalize actual usage after success and release unused reservations safely.
   History deletion and cache hits must not erase or double-count spending.
4. Restrict direct client writes to queue/cache/assets/usage. Keep user-facing
   contracts behind the existing authenticated API; a trusted server client must
   filter every operation by the verified user. Frontend history deletion
   would move behind an API endpoint. Never ship privileged keys to Vite.
5. Enforce one queued/running job per document using a partial unique index.
   Replace stale started_at recovery with lease owner, lease expiry and
   heartbeat renewal. Completion must compare the lease token so an obsolete
   worker cannot overwrite a new owner's result.
6. Deduplicate synthesis across processes with a per-user/hash claim and a
   bounded lease. Cache validation checks object availability and decodability;
   missing/corrupt entries move to repair state without silently claiming success.
7. Migrate short-conversion audio to private storage and signed playback/
   attachment URLs. Preserve existing history; provide a reviewed migration
   plan for public objects and permanent links before changing bucket policy.
8. Add reference-aware source/book/cache cleanup and configurable retention.
   Initially run cleanup in report-only mode. Do not remove user files as part
   of schema migration or deploy.
9. Isolate untrusted document parsing/OCR in a bounded subprocess, with a hard
   timeout and termination. Keep API response/progress contracts unchanged.

## Configuration constraint

Local and production service-role credentials are currently unavailable to the
audit. The trusted-server design needs an appropriately scoped server identity.
The user must supply or configure that through their own account if approved.
Do not create, rotate, replace, rename, or edit any current key or environment
variable. No environment-file change is included in this proposal.

## Verification before production

Use two disposable authenticated users and a disposable database/storage
project. Test empty bootstrap, migration over fixtures, ownership forgery,
direct-write rejection, simultaneous quota reservations, preview accounting,
duplicate content across workers, long-job heartbeat renewal, worker kill/
restart, obsolete completion rejection, cache corruption, history deletion,
private playback and download.

The acceptance gate is a complete browser upload-to-download journey under
mocked speech plus database-backed isolation/concurrency tests. A paid provider
test is unnecessary for these repeatable migration checks.

## Rollout and rollback

Prepare additive schema changes and backfill validation first. Stage code
against the new schema, verify both old and new rows, then review permission
changes and cutover separately. Keep legacy assets readable until the owner
approves the storage transition. Production SQL, credential configuration,
object deletion and deployment each remain outside this implementation
approval and require their own explicit authorization.
