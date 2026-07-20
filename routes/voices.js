const express = require("express");

const { requireAuth } = require("../lib/auth");
const {
  listVoices,
  synthesize,
  withRetry,
  resolveSettings,
  hashFor,
  TtsError,
} = require("../lib/tts");
const { checkQuota } = require("../lib/quota");

const router = express.Router();

// Long enough to hear the voice's character, short enough that browsing every
// voice in the picker costs less than one document chunk.
const PREVIEW_TEXT =
  "Here is how this voice sounds. Upload a document, and I will read it to you.";

/** GET /api/voices — every provider and voice this server can offer. */
router.get("/", requireAuth, async (req, res) => {
  try {
    res.json({ providers: await listVoices() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/voices/preview { provider?, voiceId?, modelId? }
 *
 * A few seconds of sample audio for the picker, returned as raw MP3.
 *
 * Cached under the same content-addressed scheme as document chunks, so each
 * voice is paid for once per user ever -- browsing the picker twice is free.
 */
router.post("/preview", requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const settings = resolveSettings({
      provider: req.body.provider,
      voiceId: req.body.voiceId,
      modelId: req.body.modelId,
    });

    const hash = hashFor(PREVIEW_TEXT, settings);

    const { data: cached } = await req.supabase
      .from("audio_cache")
      .select("path")
      .eq("user_id", userId)
      .eq("content_hash", hash)
      .maybeSingle();

    if (cached?.path) {
      const { data: blob, error: dlErr } = await req.supabase.storage
        .from("library")
        .download(cached.path);
      if (!dlErr && blob) {
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("X-Cache", "hit");
        return res.send(Buffer.from(await blob.arrayBuffer()));
      }
      // A cache row pointing at missing audio falls through to resynthesis.
    }

    const quota = await checkQuota(req.supabase, userId, PREVIEW_TEXT.length);
    if (!quota.ok) {
      return res.status(429).json({
        error: `Daily character limit reached (${quota.quota}); previews need ${PREVIEW_TEXT.length}.`,
      });
    }

    const audio = await withRetry(() => synthesize(PREVIEW_TEXT, settings), {
      attempts: 2,
    });

    const path = `${userId}/audio/${hash}.mp3`;
    const { error: upErr } = await req.supabase.storage
      .from("library")
      .upload(path, audio, { contentType: "audio/mpeg", upsert: true });

    // Cache write is best-effort: the preview already exists in memory and the
    // user is waiting on it.
    if (!upErr) {
      await req.supabase.from("audio_cache").upsert({
        user_id: userId,
        content_hash: hash,
        bucket: "library",
        path,
        char_count: PREVIEW_TEXT.length,
      });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("X-Cache", "miss");
    res.send(audio);
  } catch (err) {
    if (err instanceof TtsError) {
      const status = err.status === 429 ? 503 : err.retryable ? 502 : 400;
      return res.status(status).json({ error: err.message });
    }
    console.error("Voice preview failed:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, PREVIEW_TEXT };
