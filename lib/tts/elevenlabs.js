const axios = require("axios");
const { TtsError } = require("./error");

const VOICE_ID = process.env.ELEVEN_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // Adam
const MODEL_ID = process.env.ELEVEN_MODEL_ID || "eleven_flash_v2_5";

function classify(error) {
  if (!error.response) {
    // No response at all: DNS, timeout, socket reset. Transient by nature.
    return new TtsError(error.message || "Network error reaching ElevenLabs.", {
      retryable: true,
    });
  }

  const status = error.response.status;

  // ElevenLabs nests the real reason under detail: { status, message }. Both
  // matter -- the machine-readable status ("quota_exceeded") tells cases apart
  // that share an HTTP code, and the message is what to show the user.
  let detail = "";
  let detailStatus = "";
  try {
    const data = error.response.data;
    const parsed = Buffer.isBuffer(data) ? JSON.parse(data.toString()) : data;
    if (parsed && typeof parsed === "object") {
      detail =
        parsed.detail?.message ||
        (typeof parsed.detail === "string" ? parsed.detail : "") ||
        "";
      detailStatus = parsed.detail?.status || "";
    }
  } catch (_) {
    // Body was not the JSON we hoped for; the status code still tells us enough.
  }

  // A running-out-of-characters condition, however ElevenLabs dressed it up.
  const isQuota =
    detailStatus === "quota_exceeded" ||
    /quota|character limit|exceeds your|out of characters/i.test(detail);

  if (status === 401) {
    // ElevenLabs returns 401 for BOTH a bad key and an exhausted monthly
    // quota. Blindly calling every 401 "invalid key" hid the far more common
    // case -- the free tier's 10k characters/month simply ran out -- and sent
    // debugging down the wrong path. Surface the real reason.
    if (isQuota) {
      return new TtsError(
        `ElevenLabs monthly quota reached${detail ? ` — ${detail}` : "."}`,
        { status, retryable: false },
      );
    }
    return new TtsError(detail || "Invalid ElevenLabs API key.", {
      status,
      retryable: false,
    });
  }
  if (status === 422) {
    return new TtsError(
      detail || "ElevenLabs rejected the request as invalid.",
      {
        status,
        retryable: false,
      },
    );
  }
  if (status === 429) {
    const header = error.response.headers?.["retry-after"];
    const retryAfterMs = header ? Number(header) * 1000 : null;
    return new TtsError(detail || "ElevenLabs rate limit or quota exceeded.", {
      status,
      retryable: true,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null,
    });
  }
  if (status >= 500) {
    return new TtsError(detail || `ElevenLabs server error (${status}).`, {
      status,
      retryable: true,
    });
  }

  return new TtsError(detail || `ElevenLabs error (${status}).`, {
    status,
    retryable: false,
  });
}

/**
 * Synthesise one piece of text. One attempt, no retries -- retry policy lives
 * with the caller (withRetry), not the provider.
 *
 * @param {string} text
 * @param {{ voiceId?: string, modelId?: string, timeoutMs?: number }} [options]
 * @returns {Promise<Buffer>} MP3 audio
 */
async function synthesize(text, options = {}) {
  const voiceId = options.voiceId || VOICE_ID;
  const modelId = options.modelId || MODEL_ID;

  if (!process.env.ELEVEN_API_KEY) {
    throw new TtsError("ELEVEN_API_KEY is not set.", { retryable: false });
  }

  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text, model_id: modelId },
      {
        headers: {
          "xi-api-key": process.env.ELEVEN_API_KEY,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
        timeout: options.timeoutMs || 60000,
      },
    );
    return Buffer.from(res.data);
  } catch (error) {
    throw classify(error);
  }
}

// Shipped so the voice picker works before the first API round trip and keeps
// working if the /voices call fails. IDs are ElevenLabs premade voices, which
// are stable across accounts.
const FALLBACK_VOICES = [
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", description: "deep, narrative" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", description: "soft, news" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", description: "warm, British" },
  {
    id: "XB0fDUnXU5powFXDhCwa",
    name: "Charlotte",
    description: "seductive, Swedish",
  },
  {
    id: "onwK4e9ZLuTAKqWW03F9",
    name: "Daniel",
    description: "authoritative, British",
  },
];

let voicesCache = { at: 0, voices: null };
const VOICES_TTL_MS = 10 * 60 * 1000;

/**
 * Voices this account can use, from the live API when possible.
 *
 * Cached in-process: the list changes when the user edits their ElevenLabs
 * account, not per request, and the picker should not cost a round trip per
 * page load.
 */
async function listVoices() {
  if (!process.env.ELEVEN_API_KEY) return FALLBACK_VOICES;

  if (voicesCache.voices && Date.now() - voicesCache.at < VOICES_TTL_MS) {
    return voicesCache.voices;
  }

  try {
    const res = await axios.get("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": process.env.ELEVEN_API_KEY },
      timeout: 10000,
    });
    const voices = (res.data?.voices || []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      description: [v.labels?.accent, v.labels?.description]
        .filter(Boolean)
        .join(", "),
    }));
    if (voices.length) {
      voicesCache = { at: Date.now(), voices };
      return voices;
    }
  } catch (_) {
    // Fall through: a broken voices call should degrade to the static list,
    // not take the upload flow down with it.
  }
  return FALLBACK_VOICES;
}

module.exports = { synthesize, listVoices, classify, VOICE_ID, MODEL_ID };
