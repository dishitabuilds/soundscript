const express = require("express");
const rateLimit = require("express-rate-limit");

const { requireAuth } = require("../lib/auth");
const {
  synthesize,
  withRetry,
  contentHash,
  TtsError,
  VOICE_ID,
} = require("../lib/tts");
const { checkQuota } = require("../lib/quota");

const router = express.Router();

const MAX_CHARS = Number(process.env.MAX_CONVERT_CHARS || 500);

// Burst protection per IP, ahead of any auth or upstream API work.
const convertLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please wait a few minutes and try again.",
  },
});

router.post("/", convertLimiter, requireAuth, async (req, res) => {
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  const userId = req.user.id;

  if (!text) return res.status(400).json({ error: "Text input is required." });
  if (text.length > MAX_CHARS) {
    return res
      .status(400)
      .json({ error: `Text must be ${MAX_CHARS} characters or fewer.` });
  }

  try {
    const hash = contentHash(text);

    const { data: cached } = await req.supabase
      .from("tts_conversions")
      .select("audio_url")
      .eq("content_hash", hash)
      .limit(1)
      .maybeSingle();

    // Ahead of the quota check on purpose: a hit spends no credits and writes
    // no row, so counting it against the daily cap would refuse a free reply.
    if (cached?.audio_url) {
      return res.json({
        message: "Audio retrieved from cache!",
        audioUrl: cached.audio_url,
        cached: true,
      });
    }

    const quota = await checkQuota(req.supabase, userId, text.length);
    if (!quota.ok) {
      return res.status(429).json({
        error:
          `Daily limit reached (${quota.quota} characters). ` +
          `Resets 24h after your first conversion.`,
      });
    }

    const audio = await withRetry(() => synthesize(text), {
      onRetry: ({ attempt, wait }) =>
        console.warn(`convert: retry ${attempt} in ${wait}ms`),
    });

    const filePath = `${userId}/${hash}.mp3`;

    const { error: uploadError } = await req.supabase.storage
      .from("tts-bucket")
      .upload(filePath, audio, { contentType: "audio/mpeg", upsert: true });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      return res
        .status(500)
        .json({ error: `Supabase upload error: ${uploadError.message}` });
    }

    const {
      data: { publicUrl },
    } = req.supabase.storage.from("tts-bucket").getPublicUrl(filePath);

    const { error: dbError } = await req.supabase
      .from("tts_conversions")
      .insert([
        {
          input_text: text,
          audio_url: publicUrl,
          user_id: userId,
          content_hash: hash,
        },
      ]);

    // A failed insert means history and quota silently drift, so surface it.
    if (dbError) {
      console.error("History insert failed:", dbError.message);
      return res
        .status(500)
        .json({ error: `Could not save conversion: ${dbError.message}` });
    }

    res.json({
      message: "Audio generated successfully!",
      audioUrl: publicUrl,
      cached: false,
    });
  } catch (error) {
    if (error instanceof TtsError) {
      // 401/422 are our misconfiguration, not the caller's fault: report 500.
      // 429 upstream means the service is exhausted, which is a 503 here.
      const status =
        error.status === 429 ? 503 : error.status === 422 ? 400 : 500;
      return res.status(status).json({ error: error.message });
    }
    console.error("Convert failed:", error);
    res.status(500).json({ error: error.message || "Unknown server error" });
  }
});

module.exports = { router, VOICE_ID };
