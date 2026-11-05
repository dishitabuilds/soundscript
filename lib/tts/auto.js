const crypto = require("node:crypto");
const elevenlabs = require("./elevenlabs");
const kokoro = require("./kokoro");
const { TtsError } = require("./error");

// Auto is an explicitly selected provider policy, not ElevenLabs-branded audio.
// Both voice/model IDs participate in its cache key, so policy changes invalidate
// cached speech. A cached Auto result may use either declared narrator.
const VOICE_ID = `${elevenlabs.VOICE_ID}--${kokoro.VOICE_ID}`;
const MODEL_ID = `${elevenlabs.MODEL_ID}--${kokoro.MODEL_ID}`;
const quotaUntil = new Map();
const KEY = () =>
  crypto
    .createHash("sha256")
    .update(process.env.ELEVEN_API_KEY || "")
    .digest("hex");

async function synthesize(text, options = {}) {
  if (
    (options.voiceId && options.voiceId !== VOICE_ID) ||
    (options.modelId && options.modelId !== MODEL_ID)
  )
    throw new TtsError("Unsupported automatic voice policy.", { status: 422 });
  const key = KEY();
  if (process.env.ELEVEN_API_KEY && (quotaUntil.get(key) || 0) <= Date.now()) {
    try {
      return await elevenlabs.synthesize(text, {
        voiceId: elevenlabs.VOICE_ID,
        modelId: elevenlabs.MODEL_ID,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      // Authentication, invalid voices and malformed audio must stay visible.
      // Ordinary transient failures follow the existing retry policy.
      if (!(error instanceof TtsError) || !error.quotaExceeded) throw error;
      quotaUntil.set(key, Date.now() + 5 * 60 * 1000);
    }
  }
  return kokoro.synthesize(text, {
    voiceId: kokoro.VOICE_ID,
    modelId: kokoro.MODEL_ID,
    timeoutMs: options.timeoutMs,
  });
}

module.exports = {
  synthesize,
  VOICE_ID,
  MODEL_ID,
  listVoices: async () => [
    {
      id: VOICE_ID,
      name: "Automatic narrator",
      description: "ElevenLabs → free local Heart voice when credits run out",
    },
  ],
  resetQuota: () => quotaUntil.clear(),
};
