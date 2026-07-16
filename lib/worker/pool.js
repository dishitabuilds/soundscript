// Turns a document's pending chunks into audio.
//
// Shape: N workers pull from a shared queue until it is empty. The queue is the
// chunks table itself, and claim_next_chunk (FOR UPDATE SKIP LOCKED) is what
// makes that safe -- two workers asking at the same instant get different rows
// rather than the same one twice.
//
// The pool takes a Supabase client rather than building one. Given a user-scoped
// client it processes that user's document under RLS; given a service-role
// client it could drain every queued job from a standalone process. Nothing in
// here needs to change to move between the two.

const { synthesize, withRetry, TtsError } = require("../tts");
const { assembleDocument } = require("../audio/assemble");
const { publish } = require("../events");

const DEFAULT_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 3);

// A chunk that has failed this many times is not going to start working. Retry
// forever and one malformed chunk stalls its document and burns the quota.
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS || 3);

function audioPath(userId, hash) {
  return `${userId}/audio/${hash}.mp3`;
}

/**
 * Claim the job itself, atomically.
 *
 * The UPDATE only matches while status is still 'queued', so if two callers race
 * to start the same job exactly one gets a row back and the other sees none.
 * Without this guard a double-trigger runs two pools over one document, and both
 * pay for the same chunks.
 */
async function claimJob(supabase, jobId) {
  const { data, error } = await supabase
    .from("jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", jobId)
    .eq("status", "queued")
    .select();

  if (error) throw new Error(`Could not claim job: ${error.message}`);
  return Array.isArray(data) && data.length === 1;
}

async function finishJob(supabase, jobId, status, errorMessage = null) {
  const { error } = await supabase
    .from("jobs")
    .update({
      status,
      error: errorMessage,
      finished_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  if (error) console.error(`Could not finalise job ${jobId}: ${error.message}`);
}

async function markChunk(supabase, chunkId, fields) {
  const { error } = await supabase
    .from("chunks")
    .update(fields)
    .eq("id", chunkId);
  if (error)
    console.error(`Could not update chunk ${chunkId}: ${error.message}`);
}

/**
 * Synthesise one chunk, or reuse audio if this user already has it.
 */
async function processChunk(supabase, userId, chunk, log) {
  // Checked here as well as at upload time, because two chunks in the same
  // document can hold identical text -- a repeated heading, a refrain. The
  // first to finish populates the cache; without this probe the others would
  // each pay to synthesise a byte-identical result.
  const { data: cached } = await supabase
    .from("audio_cache")
    .select("path")
    .eq("user_id", userId)
    .eq("content_hash", chunk.content_hash)
    .maybeSingle();

  if (cached?.path) {
    await markChunk(supabase, chunk.id, {
      status: "done",
      path: cached.path,
      from_cache: true,
      last_error: null,
    });
    log(`chunk ${chunk.idx}: cache hit`);
    return { cached: true };
  }

  const audio = await withRetry(() => synthesize(chunk.text), {
    onRetry: ({ attempt, wait, error }) =>
      log(
        `chunk ${chunk.idx}: retry ${attempt} in ${wait}ms (${error.message})`,
      ),
  });

  const path = audioPath(userId, chunk.content_hash);

  const { error: upErr } = await supabase.storage
    .from("library")
    .upload(path, audio, { contentType: "audio/mpeg", upsert: true });

  if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

  // Cache before marking the chunk done. If the process dies between the two,
  // a retry finds the cache entry and skips the API call -- the audio is already
  // paid for and stored, so the worst case is a wasted upload, not a wasted
  // synthesis. Marking done first would risk the opposite.
  const { error: cacheErr } = await supabase.from("audio_cache").upsert({
    user_id: userId,
    content_hash: chunk.content_hash,
    bucket: "library",
    path,
    char_count: chunk.char_count,
  });

  if (cacheErr)
    log(
      `chunk ${chunk.idx}: cache write failed (non-fatal): ${cacheErr.message}`,
    );

  await markChunk(supabase, chunk.id, {
    status: "done",
    path,
    from_cache: false,
    last_error: null,
  });

  log(`chunk ${chunk.idx}: synthesised ${audio.length} bytes`);
  return { cached: false, bytes: audio.length };
}

/**
 * Run one worker until the queue is empty or the job is stopped.
 */
async function workerLoop(supabase, { userId, documentId, jobId, state, log }) {
  for (;;) {
    if (state.stopped) return;

    const { data, error } = await supabase.rpc("claim_next_chunk", {
      p_document_id: documentId,
    });

    if (error) {
      state.stopped = true;
      state.fatal = `Could not claim work: ${error.message}`;
      return;
    }

    const chunk = Array.isArray(data) ? data[0] : data;
    if (!chunk) return; // queue drained

    if (chunk.attempts > MAX_ATTEMPTS) {
      await markChunk(supabase, chunk.id, {
        status: "failed",
        last_error: `Gave up after ${MAX_ATTEMPTS} attempts.`,
      });
      state.failed++;
      continue;
    }

    try {
      const result = await processChunk(supabase, userId, chunk, log);
      state.done++;
      if (result.cached) state.cached++;

      publish(documentId, {
        type: "chunk",
        idx: chunk.idx,
        status: "done",
        cached: Boolean(result.cached),
        done: state.done,
        failed: state.failed,
      });
    } catch (err) {
      const message = err.message || String(err);
      log(`chunk ${chunk.idx}: failed -- ${message}`);

      await markChunk(supabase, chunk.id, {
        // Attempts left and the error looks transient: back to pending so a
        // later run picks it up. Otherwise it is finished, and failing it now
        // stops the pool from spinning on something that cannot succeed.
        status:
          err instanceof TtsError &&
          err.retryable &&
          chunk.attempts < MAX_ATTEMPTS
            ? "pending"
            : "failed",
        last_error: message.slice(0, 500),
      });

      state.failed++;

      publish(documentId, {
        type: "chunk",
        idx: chunk.idx,
        status: "failed",
        error: message.slice(0, 200),
        done: state.done,
        failed: state.failed,
      });

      // An exhausted API key or quota fails every remaining chunk identically.
      // Stopping the whole pool turns a hundred pointless calls into one clear
      // failure.
      if (
        err instanceof TtsError &&
        (err.status === 401 || err.status === 429)
      ) {
        state.stopped = true;
        state.fatal = err.message;
        return;
      }
    }
  }
}

/**
 * Requeue chunks that failed but still have attempts left.
 * Used when re-running a document rather than starting fresh.
 */
async function requeueFailed(supabase, documentId) {
  const { data, error } = await supabase
    .from("chunks")
    .update({ status: "pending", last_error: null })
    .eq("document_id", documentId)
    .eq("status", "failed")
    .lt("attempts", MAX_ATTEMPTS)
    .select("id");

  if (error) throw new Error(`Could not requeue: ${error.message}`);
  return data?.length || 0;
}

/**
 * Process every pending chunk of a document.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   userId: string,
 *   documentId: string,
 *   jobId: string,
 *   concurrency?: number,
 *   verbose?: boolean
 * }} options
 */
async function processDocument(supabase, options) {
  const { userId, documentId, jobId } = options;
  const concurrency = options.concurrency || DEFAULT_CONCURRENCY;

  const log = options.verbose
    ? (m) => console.log(`[job ${jobId.slice(0, 8)}] ${m}`)
    : () => {};

  const claimed = await claimJob(supabase, jobId);
  if (!claimed) {
    log("job was not queued (already running or finished); skipping");
    return { skipped: true };
  }

  const state = { done: 0, failed: 0, cached: 0, stopped: false, fatal: null };
  const started = Date.now();

  publish(documentId, { type: "job", status: "running", jobId });

  try {
    // Workers share the queue rather than being handed a slice of it, so a
    // slow chunk delays only its own worker instead of stranding a partition.
    await Promise.all(
      Array.from({ length: concurrency }, () =>
        workerLoop(supabase, { userId, documentId, jobId, state, log }),
      ),
    );
  } catch (err) {
    await finishJob(supabase, jobId, "failed", err.message);
    throw err;
  }

  const { data: progress } = await supabase.rpc("document_progress", {
    p_document_id: documentId,
  });
  const p = Array.isArray(progress) ? progress[0] : progress;

  // The database is the source of truth, not the counters this run happened to
  // accumulate: a previous run may have completed chunks this one never saw.
  const failedCount = Number(p?.failed || 0);
  let status = failedCount > 0 || state.fatal ? "failed" : "succeeded";
  let message =
    state.fatal || (failedCount > 0 ? `${failedCount} chunk(s) failed.` : null);
  let asset = null;

  // Only assemble once every chunk is done. A partial document would stitch
  // into an audiobook with silent holes where the failures were.
  if (status === "succeeded" && !options.skipAssembly) {
    try {
      publish(documentId, { type: "assembling" });
      asset = await assembleDocument(supabase, { userId, documentId, log });
    } catch (err) {
      // The synthesis itself succeeded and is cached; only assembly broke. Fail
      // the job so the state is honest, but the retry will skip straight past
      // the API calls and cost nothing.
      status = "failed";
      message = `Assembly failed: ${err.message}`;
      log(message);
    }
  }

  const elapsed = Date.now() - started;
  await finishJob(supabase, jobId, status, message);

  // Last event on this document: the SSE endpoint closes the stream on seeing
  // it, so a client is never left holding an open connection to a finished job.
  publish(documentId, {
    type: "job",
    status,
    jobId,
    error: message,
    elapsedMs: elapsed,
    asset: asset
      ? { path: asset.path, durationSeconds: asset.duration_seconds }
      : null,
  });

  log(
    `${status} in ${elapsed}ms -- ${state.done} done (${state.cached} cached), ` +
      `${state.failed} failed`,
  );

  return {
    status,
    elapsedMs: elapsed,
    done: state.done,
    cached: state.cached,
    failed: state.failed,
    progress: p,
    asset,
    error: message,
  };
}

module.exports = {
  processDocument,
  requeueFailed,
  processChunk,
  claimJob,
  MAX_ATTEMPTS,
  DEFAULT_CONCURRENCY,
};
