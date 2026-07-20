const express = require("express");
const multer = require("multer");

const { requireAuth } = require("../lib/auth");
const {
  extractText,
  ExtractError,
  ACCEPTED_EXTENSIONS,
} = require("../lib/extract");
const { chunkText } = require("../lib/text/chunker");
const { applyRules } = require("../lib/text/pronounce");
const { hashFor, resolveSettings, TtsError } = require("../lib/tts");
const { checkQuota } = require("../lib/quota");
const { processDocument, requeueFailed } = require("../lib/worker/pool");
const { subscribe } = require("../lib/events");

const router = express.Router();

// In-process synthesis is the default: one process, nothing else to deploy.
// Set INLINE_PROCESSING=false when the standalone worker (worker.js) owns the
// queue instead -- jobs are then inserted as 'queued' and left for it.
const INLINE = process.env.INLINE_PROCESSING !== "false";

/**
 * Kick off synthesis without making the client wait for it.
 *
 * Deliberately not awaited: a 40-page document takes minutes, far longer than
 * any reasonable HTTP timeout. The client gets its job id immediately and
 * follows progress from there.
 *
 * The catch is not optional -- an unawaited rejection would take the whole
 * process down under the uncaughtException handler in index.js.
 *
 * This runs in-process using the caller's own client, which means RLS still
 * applies and no service-role key is needed. The cost is that work is lost if
 * the server restarts mid-job; the standalone worker's reaper (or a manual
 * POST /:id/process) recovers from that.
 */
function startProcessing(supabase, options) {
  if (!INLINE) return; // the standalone worker will claim the queued job
  processDocument(supabase, { ...options, verbose: true }).catch((err) => {
    console.error(
      `Background processing failed for ${options.documentId}:`,
      err.message,
    );
  });
}

const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_BYTES || 20 * 1024 * 1024,
);
const MAX_CHUNK_CHARS = Number(process.env.MAX_CHUNK_CHARS || 2000);

const SOURCE_CONTENT_TYPES = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

// Memory storage: the buffer goes to the extractor and then to Supabase
// storage, so it never needs a path on this disk. MAX_UPLOAD_BYTES is what
// keeps that honest -- without a cap, one upload could exhaust the process heap.
//
// The filter only checks the extension; the real decision is made from the
// file's own bytes in lib/extract, because both the extension and the
// mimetype are client-supplied and trivially spoofed.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const ext = /\.[^.]+$/.exec(file.originalname?.toLowerCase() || "")?.[0];
    if (!ext || !(ext in ACCEPTED_EXTENSIONS)) {
      return cb(
        new Error("Unsupported file type. Upload PDF, EPUB, DOCX, TXT, or MD."),
      );
    }
    cb(null, true);
  },
});

/**
 * Everything needed to either create a document or quote its cost, computed
 * without writing anything: chunks, their hashes under the chosen voice, which
 * are already cached, and what the rest would bill.
 */
async function planChunks(supabase, userId, text, ttsSettings) {
  const chunks = chunkText(text, { maxChars: MAX_CHUNK_CHARS });
  if (chunks.length === 0)
    return {
      chunks: [],
      hashes: [],
      cacheByHash: new Map(),
      billableChars: 0,
      cachedCount: 0,
    };

  const hashes = chunks.map((c) => hashFor(c.text, ttsSettings));

  // One round trip for the whole document rather than one per chunk.
  const { data: cached, error } = await supabase
    .from("audio_cache")
    .select("content_hash, path, bucket")
    .eq("user_id", userId)
    .in("content_hash", [...new Set(hashes)]);

  if (error) throw new Error(`Cache lookup failed: ${error.message}`);

  const cacheByHash = new Map((cached || []).map((c) => [c.content_hash, c]));

  let billableChars = 0;
  let cachedCount = 0;
  chunks.forEach((chunk, i) => {
    if (cacheByHash.has(hashes[i])) cachedCount++;
    else billableChars += chunk.charCount;
  });

  return { chunks, hashes, cacheByHash, billableChars, cachedCount };
}

/**
 * Turn a plan into chunk rows for a document, marking the ones already in this
 * user's cache as done up front.
 *
 * This is what makes re-uploading an unchanged document instant and free: its
 * chunks hash identically, every one hits the cache, and no API call is made.
 */
function buildChunkRows(plan, userId, documentId) {
  return plan.chunks.map((chunk, i) => {
    const hash = plan.hashes[i];
    const hit = plan.cacheByHash.get(hash);
    return {
      document_id: documentId,
      user_id: userId,
      idx: chunk.idx,
      text: chunk.text,
      char_count: chunk.charCount,
      content_hash: hash,
      status: hit ? "done" : "pending",
      path: hit ? hit.path : null,
      from_cache: Boolean(hit),
      // Structure from the chunker. Not derivable from the row afterwards, and
      // stitching needs both -- pause length and chapter marks come from here.
      paragraph_idx: chunk.paragraphIdx,
      ends_paragraph: chunk.endsParagraph,
    };
  });
}

/**
 * Shared front half of POST /: turn the request into text + settings, applying
 * the caller's pronunciation rules. Used by both the real create and the
 * estimate, which must agree to the character on what would be synthesised.
 */
async function prepareSubmission(req) {
  let text;
  let title;
  let sourceType;
  let fileBuffer = null;

  if (req.file) {
    fileBuffer = req.file.buffer;

    let extracted;
    try {
      extracted = await extractText(fileBuffer, {
        filename: req.file.originalname,
      });
    } catch (err) {
      if (err instanceof ExtractError)
        return { status: 400, error: err.message };
      // A corrupt file is the user's problem to fix, not a server fault.
      return { status: 400, error: `Could not read that file: ${err.message}` };
    }

    text = extracted.text;
    sourceType = extracted.sourceType;
    title = (req.body.title || req.file.originalname || "Untitled").replace(
      /\.[^.]+$/,
      "",
    );
  } else if (typeof req.body.text === "string") {
    text = req.body.text.trim();
    title = req.body.title || "Pasted text";
    sourceType = "paste";
  } else {
    return { status: 400, error: "Send a file or a text field." };
  }

  if (!text || !text.trim()) {
    return {
      status: 400,
      error: "No readable text found. Scanned PDFs need OCR first.",
    };
  }

  let ttsSettings;
  try {
    ttsSettings = resolveSettings({
      provider: req.body.provider,
      voiceId: req.body.voiceId,
      modelId: req.body.modelId,
    });
  } catch (err) {
    if (err instanceof TtsError) return { status: 400, error: err.message };
    throw err;
  }

  // Rules apply before hashing, so corrected text caches under its own keys.
  const { data: rules, error: rulesErr } = await req.supabase
    .from("pronunciation_rules")
    .select("pattern, replacement");
  if (rulesErr) return { status: 500, error: rulesErr.message };
  text = applyRules(text, rules || []);

  return { text, title, sourceType, fileBuffer, ttsSettings };
}

/**
 * POST /api/documents
 *
 * multipart/form-data with `file` (PDF, EPUB, DOCX, TXT, MD) and optional
 * `title`, `provider`, `voiceId`, `modelId`; or application/json with
 * { title, text, provider?, voiceId?, modelId? } for pasted text.
 *
 * With `estimate` set (form field or JSON), nothing is written: the response
 * quotes chunk counts, cache hits, billable characters and quota so the client
 * can show a confirm step before spending anything.
 *
 * Otherwise extracts, cleans, chunks, and queues a job. Returns immediately --
 * synthesis happens in the background, because a 40-page chapter takes minutes
 * and no HTTP client should be asked to hold a connection open that long.
 */
router.post("/", requireAuth, upload.single("file"), async (req, res) => {
  const userId = req.user.id;

  try {
    const prep = await prepareSubmission(req);
    if (prep.error) return res.status(prep.status).json({ error: prep.error });

    const { text, title, sourceType, fileBuffer, ttsSettings } = prep;
    const estimateOnly = ["1", "true", true].includes(req.body.estimate);

    const plan = await planChunks(req.supabase, userId, text, ttsSettings);

    if (plan.chunks.length === 0) {
      return res.status(400).json({ error: "No readable text found." });
    }

    const quota = await checkQuota(req.supabase, userId, plan.billableChars);

    if (estimateOnly) {
      return res.json({
        estimate: {
          title: title.slice(0, 200),
          sourceType,
          charCount: text.length,
          chunks: {
            total: plan.chunks.length,
            cached: plan.cachedCount,
            pending: plan.chunks.length - plan.cachedCount,
          },
          billableChars: plan.billableChars,
          fits: quota.ok,
          quota: {
            used: quota.used,
            remaining: quota.remaining,
            limit: quota.quota,
          },
          voice: ttsSettings,
        },
      });
    }

    if (!quota.ok) {
      return res.status(429).json({
        error:
          `This document needs ${plan.billableChars} characters but only ` +
          `${quota.remaining} remain of your ${quota.quota}/day. ` +
          `Try a shorter document or wait for the window to roll over.`,
        needed: plan.billableChars,
        remaining: quota.remaining,
      });
    }

    // Create the document first so chunks have something to hang off. If a later
    // step fails, this is cleaned up below rather than left as an empty shell.
    const { data: doc, error: docError } = await req.supabase
      .from("documents")
      .insert({
        user_id: userId,
        title: title.slice(0, 200),
        source_type: sourceType,
        char_count: text.length,
        provider: ttsSettings.provider,
        voice_id: ttsSettings.voiceId,
        model_id: ttsSettings.modelId,
      })
      .select()
      .single();

    if (docError) {
      console.error("Document insert failed:", docError.message);
      return res
        .status(500)
        .json({ error: `Could not create document: ${docError.message}` });
    }

    const cleanup = async (reason) => {
      console.error(`Rolling back document ${doc.id}: ${reason}`);
      await req.supabase.from("documents").delete().eq("id", doc.id);
    };

    const rows = buildChunkRows(plan, userId, doc.id);

    const { error: chunkError } = await req.supabase
      .from("chunks")
      .insert(rows);
    if (chunkError) {
      await cleanup(chunkError.message);
      return res
        .status(500)
        .json({ error: `Could not create chunks: ${chunkError.message}` });
    }

    // Store the original only once everything else has succeeded, so a rejected
    // upload leaves nothing behind in the bucket.
    if (fileBuffer) {
      const sourcePath = `${userId}/sources/${doc.id}.${sourceType}`;
      const { error: upErr } = await req.supabase.storage
        .from("library")
        .upload(sourcePath, fileBuffer, {
          contentType:
            SOURCE_CONTENT_TYPES[sourceType] || "application/octet-stream",
          upsert: true,
        });

      if (upErr) {
        console.error("Source upload failed (non-fatal):", upErr.message);
      } else {
        await req.supabase
          .from("documents")
          .update({ source_path: sourcePath })
          .eq("id", doc.id);
      }
    }

    // Queued even when every chunk was cached. Synthesis is not the only work a
    // job does -- the chunks still have to be stitched into an audiobook, and
    // short-circuiting to 'succeeded' here would leave a document that claims to
    // be finished but has no audio to play.
    const { data: job, error: jobError } = await req.supabase
      .from("jobs")
      .insert({
        document_id: doc.id,
        user_id: userId,
        status: "queued",
      })
      .select()
      .single();

    if (jobError) {
      await cleanup(jobError.message);
      return res
        .status(500)
        .json({ error: `Could not queue job: ${jobError.message}` });
    }

    res.status(201).json({
      document: {
        id: doc.id,
        title: doc.title,
        sourceType,
        charCount: text.length,
      },
      job: { id: job.id, status: job.status },
      chunks: {
        total: rows.length,
        cached: plan.cachedCount,
        pending: rows.length - plan.cachedCount,
      },
      billableChars: plan.billableChars,
      quota: {
        used: quota.used,
        remaining: quota.remaining,
        limit: quota.quota,
      },
    });

    // After the response, so a slow first chunk cannot delay it. Started even
    // with nothing pending, because assembly is still owed.
    startProcessing(req.supabase, {
      userId,
      documentId: doc.id,
      jobId: job.id,
    });
  } catch (err) {
    console.error("Document create failed:", err);
    res
      .status(500)
      .json({ error: err.message || "Could not create document." });
  }
});

/** GET /api/documents — the caller's library, newest first. */
router.get("/", requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from("documents")
    .select("id, title, source_type, char_count, created_at")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ documents: data });
});

/** GET /api/documents/:id — one document with live progress. */
router.get("/:id", requireAuth, async (req, res) => {
  const { data: doc, error } = await req.supabase
    .from("documents")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  // RLS already filters other users' rows out, so "not visible" and "does not
  // exist" are the same answer here -- and 404 for both avoids confirming that
  // someone else's document id is real.
  if (!doc) return res.status(404).json({ error: "Document not found." });

  const [
    { data: progress },
    { data: jobs },
    { data: asset },
    { data: position },
  ] = await Promise.all([
    req.supabase.rpc("document_progress", { p_document_id: doc.id }),
    req.supabase
      .from("jobs")
      .select("*")
      .eq("document_id", doc.id)
      .order("created_at", { ascending: false })
      .limit(1),
    req.supabase
      .from("audio_assets")
      .select("*")
      .eq("document_id", doc.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    req.supabase
      .from("listening_positions")
      .select("position_seconds, updated_at")
      .eq("document_id", doc.id)
      .maybeSingle(),
  ]);

  res.json({
    document: doc,
    progress: Array.isArray(progress) ? progress[0] : progress,
    job: jobs?.[0] || null,
    asset: asset || null,
    position: position || null,
  });
});

/**
 * GET /api/documents/:id/text — the chunk text in reading order.
 *
 * The read-along view joins this to asset.timeline by idx: timeline says when
 * each chunk is being spoken, this says what it says.
 */
router.get("/:id/text", requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from("chunks")
    .select("idx, text, paragraph_idx")
    .eq("document_id", req.params.id)
    .order("idx");

  if (error) return res.status(500).json({ error: error.message });
  if (!data?.length)
    return res.status(404).json({ error: "Document not found." });
  res.json({ chunks: data });
});

/**
 * PUT /api/documents/:id/position { seconds }
 *
 * Remember where playback is, so any device can resume there. Last write wins;
 * position updates race only with themselves and the newest one is the truth.
 */
router.put("/:id/position", requireAuth, async (req, res) => {
  const seconds = Number(req.body.seconds);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return res
      .status(400)
      .json({ error: "seconds must be a non-negative number." });
  }

  const { error } = await req.supabase.from("listening_positions").upsert({
    user_id: req.user.id,
    document_id: req.params.id,
    position_seconds: seconds,
    updated_at: new Date().toISOString(),
  });

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

/**
 * GET /api/documents/:id/events
 *
 * Server-sent events for one document's progress.
 *
 * Authenticated by the normal Authorization header, which means the client must
 * read it with fetch() rather than EventSource -- EventSource cannot set
 * headers, and the usual workaround of putting the JWT in the query string puts
 * a credential somewhere that gets logged by every proxy on the way.
 */
router.get("/:id/events", requireAuth, async (req, res) => {
  const documentId = req.params.id;

  // RLS decides visibility. Checked before opening the stream so an unauthorised
  // caller gets a clean 404 rather than a socket that never says anything.
  const { data: doc } = await req.supabase
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .maybeSingle();

  if (!doc) return res.status(404).json({ error: "Document not found." });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Nginx and friends buffer responses by default, which holds events back
    // until enough bytes pile up -- exactly wrong for a live stream.
    "X-Accel-Buffering": "no",
  });

  let open = true;
  const send = (event) => {
    if (!open) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // A client can attach after work has already started, so the stream opens with
  // the current state rather than leaving it blank until the next chunk lands.
  const { data: progress } = await req.supabase.rpc("document_progress", {
    p_document_id: documentId,
  });
  const { data: jobs } = await req.supabase
    .from("jobs")
    .select("id, status, error")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false })
    .limit(1);

  const job = jobs?.[0] || null;
  send({
    type: "snapshot",
    progress: Array.isArray(progress) ? progress[0] : progress,
    job,
  });

  const cleanup = () => {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };

  const unsubscribe = subscribe(documentId, (event) => {
    send(event);
    // Nothing more will ever be published for a finished job, so holding the
    // connection open just leaks a socket per completed document.
    if (
      event.type === "job" &&
      (event.status === "succeeded" || event.status === "failed")
    ) {
      cleanup();
    }
  });

  // Proxies and load balancers drop connections that go quiet. A comment frame
  // is ignored by the client but keeps the socket demonstrably alive.
  const heartbeat = setInterval(() => {
    if (open) res.write(": ping\n\n");
  }, 15000);

  // Fires on tab close, navigation, or network drop. Without it every abandoned
  // stream keeps its listener and interval forever.
  req.on("close", cleanup);

  // Already finished before the client attached: the snapshot is the whole
  // story, so say so and close rather than waiting for an event that will not
  // come.
  if (job && (job.status === "succeeded" || job.status === "failed")) {
    send({ type: "job", status: job.status, jobId: job.id, error: job.error });
    cleanup();
  }
});

/**
 * POST /api/documents/:id/process
 *
 * Resume a document: requeue whatever failed, start a fresh job, run it.
 * Covers both a partial failure and work stranded by a server restart.
 */
router.post("/:id/process", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const documentId = req.params.id;

  const { data: doc, error: docErr } = await req.supabase
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .maybeSingle();

  if (docErr) return res.status(500).json({ error: docErr.message });
  if (!doc) return res.status(404).json({ error: "Document not found." });

  // Refuse to pile a second pool onto a document already being worked. Without
  // this, an impatient double-click runs two pools over one queue.
  const { data: active } = await req.supabase
    .from("jobs")
    .select("id, status")
    .eq("document_id", documentId)
    .in("status", ["queued", "running"])
    .limit(1);

  if (active?.length) {
    return res.status(409).json({
      error: "This document is already being processed.",
      job: active[0],
    });
  }

  try {
    const requeued = await requeueFailed(req.supabase, documentId);

    const { data: progress } = await req.supabase.rpc("document_progress", {
      p_document_id: documentId,
    });
    const p = Array.isArray(progress) ? progress[0] : progress;
    const outstanding = Number(p?.pending || 0) + Number(p?.processing || 0);
    const failedCount = Number(p?.failed || 0);

    const { data: asset } = await req.supabase
      .from("audio_assets")
      .select("id")
      .eq("document_id", documentId)
      .maybeSingle();

    // Nothing pending is not the same as nothing to do: synthesis can be
    // complete while assembly never ran, or ran and failed. Only refuse when
    // there is genuinely no work left.
    if (outstanding === 0 && (failedCount > 0 || asset)) {
      return res.status(200).json({
        message:
          failedCount > 0
            ? "Nothing left to retry -- the remaining chunks have exhausted their attempts."
            : "Document is already fully synthesised.",
        progress: p,
      });
    }

    const { data: job, error: jobErr } = await req.supabase
      .from("jobs")
      .insert({ document_id: documentId, user_id: userId, status: "queued" })
      .select()
      .single();

    if (jobErr) return res.status(500).json({ error: jobErr.message });

    res.status(202).json({
      job: { id: job.id, status: job.status },
      requeued,
      outstanding,
    });

    startProcessing(req.supabase, { userId, documentId, jobId: job.id });
  } catch (err) {
    console.error("Process failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/documents/:id — removes the document; chunks cascade. */
router.delete("/:id", requireAuth, async (req, res) => {
  const { error } = await req.supabase
    .from("documents")
    .delete()
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = { router, planChunks, buildChunkRows };
