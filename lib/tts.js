const crypto = require("crypto");
const axios = require("axios");

const VOICE_ID = process.env.ELEVEN_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // Adam
const MODEL_ID = process.env.ELEVEN_MODEL_ID || "eleven_flash_v2_5";

class TtsError extends Error {
  constructor(
    message,
    { status, retryable = false, retryAfterMs = null } = {},
  ) {
    super(message);
    this.name = "TtsError";
    this.status = status;
    // Whether trying the identical request again could plausibly succeed. A 429
    // or a 5xx is worth another go; a 401 or a 422 will fail identically
    // forever, and retrying it just burns the budget slower.
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Cache key for synthesised audio. The voice and model are part of it because
 * the same text through a different voice is different audio.
 */
function contentHash(text, voiceId = VOICE_ID, modelId = MODEL_ID) {
  return crypto
    .createHash("sha256")
    .update(`${voiceId}:${modelId}:${text}`)
    .digest("hex");
}

function classify(error) {
  if (!error.response) {
    // No response at all: DNS, timeout, socket reset. Transient by nature.
    return new TtsError(error.message || "Network error reaching ElevenLabs.", {
      retryable: true,
    });
  }

  const status = error.response.status;

  let detail = "";
  try {
    const data = error.response.data;
    if (Buffer.isBuffer(data))
      detail = JSON.parse(data.toString()).detail?.message || "";
    else if (data && typeof data === "object")
      detail = data.detail?.message || "";
  } catch (_) {
    // Body was not the JSON we hoped for; the status code still tells us enough.
  }

  if (status === 401) {
    return new TtsError("Invalid ElevenLabs API key.", {
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
 * Synthesise one piece of text. One attempt, no retries -- see withRetry.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a synthesis with exponential backoff.
 *
 * Backoff is jittered because the worker pool runs several synthesis calls at
 * once: without jitter, a 429 hits every worker at the same instant, they all
 * sleep the same 1000ms, and they all retry in the same instant -- rebuilding
 * the exact spike that triggered the limit. Randomising spreads them out.
 *
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, baseMs?: number, maxMs?: number, onRetry?: Function }} [options]
 * @returns {Promise<T>}
 * @template T
 */
async function withRetry(fn, options = {}) {
  const attempts = options.attempts ?? 4;
  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 15000;

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // A permanent failure will fail the same way every time; stop immediately
      // rather than spending the remaining attempts proving it.
      if (!(err instanceof TtsError) || !err.retryable) throw err;
      if (attempt === attempts) break;

      const backoff = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
      // Respect Retry-After when the server sends one -- it knows better than
      // our formula does.
      const wait =
        err.retryAfterMs ?? Math.round(backoff * (0.5 + Math.random()));

      if (options.onRetry) options.onRetry({ attempt, wait, error: err });
      await sleep(wait);
    }
  }

  throw lastError;
}

module.exports = {
  synthesize,
  withRetry,
  contentHash,
  TtsError,
  VOICE_ID,
  MODEL_ID,
};
