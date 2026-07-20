// Standalone queue worker.
//
// The API can synthesise in-process (simple, but work dies with the server) or
// leave jobs queued for this process to pick up (survives restarts and
// deploys). Which mode is active is decided by INLINE_PROCESSING on the API
// side; this worker is correct in either mode because claim_next_chunk and
// claimJob are atomic -- at worst it finds nothing to do.
//
// Run it with: npm run worker   (requires SUPABASE_SERVICE_ROLE_KEY)
//
// The pool was written to take any Supabase client; given the service-role
// client here it drains every user's queue, exactly as the README promised:
// "moving to a standalone worker later means changing only the trigger."

require("dotenv").config();

const { getServiceClient } = require("./lib/supabase");
const { processDocument } = require("./lib/worker/pool");
const { notifyJobFinished, notificationsEnabled } = require("./lib/notify");

const POLL_MS = Number(process.env.WORKER_POLL_MS || 3000);

// A chunk stuck in 'processing' or a job stuck in 'running' longer than this
// was orphaned by a crash -- nothing legitimate holds a chunk for ten minutes.
const STALE_MINUTES = Number(process.env.WORKER_STALE_MINUTES || 10);

// How many documents this process works at once. Each document already runs
// its own concurrent pool internally, so this multiplies out fast.
const MAX_PARALLEL_JOBS = Number(process.env.WORKER_PARALLEL_JOBS || 2);

const log = (m) => console.log(`[worker] ${new Date().toISOString()} ${m}`);

/**
 * Return crashed work to the queue.
 *
 * A chunk in 'processing' whose updated_at is old belongs to a worker that no
 * longer exists; flipping it to 'pending' lets the next claim pick it up. Its
 * attempts counter survives, so a chunk that keeps killing workers still runs
 * out of budget instead of looping forever.
 *
 * Stale 'running' jobs are re-queued the same way so the job claim in
 * processDocument can hand them to a fresh pool.
 */
async function reapStaleWork(supabase) {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

  const { data: chunks, error: chunkErr } = await supabase
    .from("chunks")
    .update({ status: "pending" })
    .eq("status", "processing")
    .lt("updated_at", cutoff)
    .select("id");

  if (chunkErr) log(`reaper: chunk sweep failed: ${chunkErr.message}`);
  else if (chunks?.length)
    log(`reaper: requeued ${chunks.length} stale chunk(s)`);

  const { data: jobs, error: jobErr } = await supabase
    .from("jobs")
    .update({ status: "queued", started_at: null })
    .eq("status", "running")
    .lt("started_at", cutoff)
    .select("id");

  if (jobErr) log(`reaper: job sweep failed: ${jobErr.message}`);
  else if (jobs?.length) log(`reaper: requeued ${jobs.length} stale job(s)`);
}

/** Oldest queued jobs first, capped at what this process will run at once. */
async function findQueuedJobs(supabase) {
  const { data, error } = await supabase
    .from("jobs")
    .select("id, document_id, user_id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(MAX_PARALLEL_JOBS);

  if (error) {
    log(`queue poll failed: ${error.message}`);
    return [];
  }
  return data || [];
}

async function main() {
  const supabase = getServiceClient();
  if (!supabase) {
    console.error(
      "worker: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
    );
    process.exit(1);
  }

  log(`started (poll ${POLL_MS}ms, stale after ${STALE_MINUTES}m)`);

  // Boot sweep first: work stranded by the previous deploy is the most likely
  // work there is.
  await reapStaleWork(supabase);

  const inFlight = new Set();
  let lastReap = Date.now();
  let stopping = false;

  const stop = () => {
    // Finish what is claimed, take nothing new. Chunks are claimed one at a
    // time, so the window of loss on a hard kill is one chunk per worker --
    // and the reaper recovers even that on the next boot.
    log("stopping after in-flight jobs finish");
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  for (;;) {
    if (stopping && inFlight.size === 0) break;

    if (!stopping) {
      // Periodic reap, not just at boot: this process may be the survivor of a
      // pair, cleaning up after a sibling that crashed mid-document.
      if (Date.now() - lastReap > STALE_MINUTES * 60 * 1000) {
        await reapStaleWork(supabase);
        lastReap = Date.now();
      }

      if (inFlight.size < MAX_PARALLEL_JOBS) {
        const jobs = await findQueuedJobs(supabase);
        for (const job of jobs) {
          if (inFlight.size >= MAX_PARALLEL_JOBS) break;
          if (inFlight.has(job.id)) continue;

          inFlight.add(job.id);
          log(`claiming job ${job.id} (document ${job.document_id})`);

          processDocument(supabase, {
            userId: job.user_id,
            documentId: job.document_id,
            jobId: job.id,
            verbose: true,
          })
            .then(async (result) => {
              // Skipped means another process won the claim; their finish,
              // their email.
              if (result?.skipped || !notificationsEnabled()) return;
              const { data: doc } = await supabase
                .from("documents")
                .select("title")
                .eq("id", job.document_id)
                .maybeSingle();
              await notifyJobFinished(supabase, {
                userId: job.user_id,
                title: doc?.title || "Untitled",
                status: result?.status,
                error: result?.error,
              });
            })
            .catch((err) => log(`job ${job.id} failed: ${err.message}`))
            .finally(() => inFlight.delete(job.id));
        }
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  log("stopped");
  process.exit(0);
}

main();
