// Text-to-speech behind one interface, whichever provider does the work.
//
// Callers say what to speak and (optionally) which provider/voice/model; this
// module fills in defaults, dispatches, and owns the retry policy and the
// cache-key format. Providers only translate one request and classify one
// error -- everything shared lives here, so adding a provider is one file and
// one registry entry.

const crypto = require("crypto");

const { TtsError } = require("./error");
const elevenlabs = require("./elevenlabs");
const openai = require("./openai");

const PROVIDERS = { elevenlabs, openai };

const DEFAULT_PROVIDER = process.env.TTS_PROVIDER || "elevenlabs";

// Kept for existing callers; these are the default provider's defaults.
const VOICE_ID = elevenlabs.VOICE_ID;
const MODEL_ID = elevenlabs.MODEL_ID;

function providerKeyPresent(name) {
  if (name === "elevenlabs") return Boolean(process.env.ELEVEN_API_KEY);
  if (name === "openai") return Boolean(process.env.OPENAI_API_KEY);
  return false;
}

/**
 * Fill in defaults and validate the provider name.
 *
 * Null and undefined inputs are expected -- a document row with no voice
 * columns set means "use the server defaults", and must keep meaning that.
 */
function resolveSettings({ provider, voiceId, modelId } = {}) {
  const name = provider || DEFAULT_PROVIDER;
  const impl = PROVIDERS[name];
  if (!impl) {
    throw new TtsError(
      `Unknown TTS provider "${name}". Available: ${Object.keys(PROVIDERS).join(", ")}.`,
      { retryable: false },
    );
  }
  return {
    provider: name,
    voiceId: voiceId || impl.VOICE_ID,
    modelId: modelId || impl.MODEL_ID,
  };
}

/**
 * Cache key for synthesised audio. Voice and model are part of it because the
 * same text through a different voice is different audio.
 *
 * The elevenlabs key deliberately omits the provider prefix: it is the format
 * every existing audio_cache row was written under, and prefixing it now would
 * orphan all of them and re-bill every re-upload.
 */
function contentHash(
  text,
  voiceId = VOICE_ID,
  modelId = MODEL_ID,
  provider = "elevenlabs",
) {
  const key =
    provider === "elevenlabs"
      ? `${voiceId}:${modelId}:${text}`
      : `${provider}:${voiceId}:${modelId}:${text}`;
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** contentHash driven by a settings object, as resolveSettings returns. */
function hashFor(text, settings) {
  const { provider, voiceId, modelId } = resolveSettings(settings);
  return contentHash(text, voiceId, modelId, provider);
}

/**
 * Synthesise one piece of text. One attempt, no retries -- see withRetry.
 *
 * @param {string} text
 * @param {{ provider?: string, voiceId?: string, modelId?: string,
 *           timeoutMs?: number }} [options]
 * @returns {Promise<Buffer>} MP3 audio
 */
async function synthesize(text, options = {}) {
  const { provider, voiceId, modelId } = resolveSettings(options);
  return PROVIDERS[provider].synthesize(text, {
    voiceId,
    modelId,
    timeoutMs: options.timeoutMs,
  });
}

/**
 * Every voice the server can offer right now, grouped by provider. Providers
 * without an API key are reported but flagged, so the picker can explain why
 * an option is greyed out instead of hiding it.
 */
async function listVoices() {
  const providers = await Promise.all(
    Object.entries(PROVIDERS).map(async ([name, impl]) => ({
      id: name,
      available: providerKeyPresent(name),
      default: name === DEFAULT_PROVIDER,
      defaultVoiceId: impl.VOICE_ID,
      voices: await impl.listVoices(),
    })),
  );
  return providers;
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
  hashFor,
  resolveSettings,
  listVoices,
  TtsError,
  VOICE_ID,
  MODEL_ID,
  DEFAULT_PROVIDER,
  PROVIDERS,
};
